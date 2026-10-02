/**
 * HLV không xem được số liệu của đồng nghiệp.
 *
 * GET /trainers trả SĐT, doanh thu, hoa hồng từng người — trước đây HLV gọi
 * được (để có danh sách cho ô chọn ở form bán gói). Giờ ô chọn dùng
 * /trainers/options: chỉ id, mã, tên.
 *
 * Cùng cách dựng với checkin-manual.spec.ts: service thật, đóng vai app_rw để
 * RLS áp như API thật, mỗi test rollback.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Reflector } from '@nestjs/core';
import type { DB, TenantRole } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { requestContext } from '../src/common/tenant-context';
import { ROLES } from '../src/common/auth.guard';
import { TrainerController } from '../src/trainer/trainer.controller';
import { TrainerService } from '../src/trainer/trainer.service';

config({ path: resolve(__dirname, '../../../.env') });

/** BEGIN/COMMIT của service thành SAVEPOINT — không đóng transaction ngoài của test. */
function savepointKysely(c: Client): Kysely<DB> {
  let n = 0;
  const stack: string[] = [];
  const conn = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim().toLowerCase();
      if (t === 'begin') {
        const sp = `sp_${++n}`;
        stack.push(sp);
        return c.query(`SAVEPOINT ${sp}`);
      }
      if (t === 'commit') return c.query(`RELEASE SAVEPOINT ${stack.pop()}`);
      if (t === 'rollback') {
        const sp = stack.pop();
        await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        return c.query(`RELEASE SAVEPOINT ${sp}`);
      }
      return c.query(text, params as unknown[]);
    },
    release: () => {},
  };
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: { connect: async () => conn, end: async () => {} } as never }),
  });
}

let c: Client;
let tenantA: string;
let trainers: TrainerService;

beforeAll(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!t.rows[0]) throw new Error('Cần dữ liệu seed. Chạy: pnpm db:seed');
  tenantA = t.rows[0].id;
  trainers = new TrainerService(new TenantDb(savepointKysely(c)));
});

afterAll(async () => {
  await c.end().catch(() => {});
});

beforeEach(async () => {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE app_rw');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
});
afterEach(async () => {
  await c.query('ROLLBACK');
});

const vaiTro = (method: keyof TrainerController) =>
  new Reflector().get<TenantRole[]>(ROLES, TrainerController.prototype[method] as () => unknown);

describe('danh sách huấn luyện viên', () => {
  it('GET /trainers (có lương, hoa hồng) không mở cho HLV', () => {
    expect(vaiTro('list')).not.toContain('PT');
    expect(vaiTro('list')).toEqual(expect.arrayContaining(['OWNER', 'ADMIN', 'RECEPTION']));
  });

  it('GET /trainers/options mở cho HLV — để bán gói', () => {
    expect(vaiTro('options')).toContain('PT');
  });

  it('/trainers/options chỉ có id, mã, tên của HLV đang làm', async () => {
    const pt = (
      await c.query<{ identity_id: string; id: string }>(
        `SELECT identity_id, id FROM trainer WHERE status = 'ACTIVE' LIMIT 1`,
      )
    ).rows[0]!;
    const ds = await requestContext.run(
      { tenantId: tenantA, requestId: 'test', identityId: pt.identity_id, roles: ['PT'], trainerId: pt.id },
      () => trainers.options(),
    );
    expect(ds.length).toBeGreaterThan(0);
    for (const t of ds) expect(Object.keys(t).sort()).toEqual(['code', 'fullName', 'id']);

    const dangLam = await c.query(`SELECT count(*)::int AS n FROM trainer WHERE status = 'ACTIVE'`);
    expect(ds).toHaveLength(dangLam.rows[0].n);
  });
});
