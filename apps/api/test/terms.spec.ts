/**
 * Điều khoản & chính sách (0023): lưu theo phiên bản, chỉ thêm không sửa,
 * chỉ chủ phòng đăng, mọi người trong phòng đọc.
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
import { TermsService } from '../src/terms/terms.service';
import { TermsController } from '../src/terms/terms.controller';

config({ path: resolve(__dirname, '../../../.env') });

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
let tenantB: string;
let owner: string;
let terms: TermsService;

const asOwner = <T>(fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, requestId: 'test', identityId: owner, roles: ['OWNER'] }, fn);

async function sqlLoi(text: string, params: unknown[] = []): Promise<string> {
  await c.query('SAVEPOINT thu');
  try {
    await c.query(text, params);
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT thu');
    return (e as { constraint?: string; message: string }).constraint ?? (e as Error).message;
  }
  await c.query('RELEASE SAVEPOINT thu');
  throw new Error('Mong SQL vỡ nhưng không');
}

const BAN_1 = 'Hội viên đến muộn quá 15 phút được tính là vắng mặt.';
const BAN_2 = 'Hội viên đến muộn quá 10 phút được tính là vắng mặt. Gói tập không hoàn tiền.';

beforeAll(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 2`);
  if (t.rows.length < 2) throw new Error('Cần dữ liệu seed hai phòng. Chạy: pnpm db:seed');
  tenantA = t.rows[0]!.id;
  tenantB = t.rows[1]!.id;
  owner = (
    await c.query<{ identity_id: string }>(
      `SELECT identity_id FROM tenant_user WHERE tenant_id = $1 AND role = 'OWNER' LIMIT 1`,
      [tenantA],
    )
  ).rows[0]!.identity_id;
  terms = new TermsService(new TenantDb(savepointKysely(c)));
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

describe('Điều khoản & chính sách', () => {
  it('quyền: hội viên đọc được, chỉ chủ phòng đăng', () => {
    const vai = (m: keyof TermsController) =>
      new Reflector().get<TenantRole[]>(ROLES, TermsController.prototype[m] as () => unknown);
    expect(vai('current')).toContain('MEMBER');
    expect(vai('publish')).toEqual(['OWNER']);
    expect(vai('versions')).not.toContain('MEMBER');
  });

  it('mỗi lần lưu là một phiên bản; bản hiệu lực là bản mới nhất', async () => {
    const goc = (await asOwner(() => terms.current())).current?.version ?? 0;
    const v1 = await asOwner(() => terms.publish({ content: BAN_1 }));
    const v2 = await asOwner(() => terms.publish({ content: BAN_2 }));
    expect([v1.version, v2.version]).toEqual([goc + 1, goc + 2]);
    expect((await asOwner(() => terms.current())).current).toMatchObject({ version: goc + 2, content: BAN_2 });

    const ds = await asOwner(() => terms.versions());
    expect(ds.slice(0, 2).map((v) => v.version)).toEqual([goc + 2, goc + 1]);

    const al = await c.query(`SELECT 1 FROM audit_log WHERE action = 'TERMS_PUBLISHED' AND tenant_id = $1`, [tenantA]);
    expect(al.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('lưu lại y nguyên nội dung: không sinh phiên bản mới', async () => {
    const v1 = await asOwner(() => terms.publish({ content: BAN_1 }));
    const lai = await asOwner(() => terms.publish({ content: BAN_1 }));
    expect(lai.version).toBe(v1.version);
  });

  it('CSDL: không sửa, không xoá phiên bản đã đăng', async () => {
    await asOwner(() => terms.publish({ content: BAN_1 }));
    expect(await sqlLoi(`UPDATE tenant_terms SET content = 'đổi lén nội dung cũ cho khớp tranh chấp'`)).toMatch(
      /permission denied/,
    );
    expect(await sqlLoi(`DELETE FROM tenant_terms`)).toMatch(/permission denied/);
  });

  it('phòng khác không đọc được điều khoản của phòng này', async () => {
    await asOwner(() => terms.publish({ content: BAN_1 }));
    await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
    const r = await c.query(`SELECT 1 FROM tenant_terms WHERE tenant_id = $1`, [tenantA]);
    expect(r.rows).toHaveLength(0);
  });
});
