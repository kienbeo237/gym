/**
 * Tặng buổi cho hội viên (0022).
 *
 * Điều phải giữ:
 *  - chỉ chủ phòng / quản lý tặng được, có lý do, có người tặng (CSDL chặn cả
 *    đường SQL tay);
 *  - buổi tặng DÙNG ĐƯỢC tới hết (mp_sessions_range đã nới) nhưng không quá;
 *  - doanh thu không đổi: buổi vượt số buổi mua ghi nhận 0 đồng, còn hoa hồng
 *    dạy theo % vẫn tính trên đơn giá bình quân;
 *  - huỷ hoá đơn đảo cả buổi tặng.
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
import { CommissionService } from '../src/commission/commission.service';
import { SessionConsumptionService } from '../src/attendance/session-consumption.service';
import { SaleService } from '../src/sale/sale.service';
import { BillingService } from '../src/billing/billing.service';
import { MemberService } from '../src/member/member.service';
import { MemberController } from '../src/member/member.controller';

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
let owner: string;
let tdb: TenantDb;
let sale: SaleService;
let billing: BillingService;
let members: MemberService;
let consumption: SessionConsumptionService;

const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

const vai = <T>(who: { identityId: string; roles: TenantRole[] }, fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, requestId: 'test', ...who }, fn);
const asOwner = <T>(fn: () => Promise<T>) => vai({ identityId: owner, roles: ['OWNER'] }, fn);

async function loi(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    const body = err.getResponse?.() as { code?: string; message?: string } | string | undefined;
    return {
      status: err.getStatus?.() ?? 500,
      code: typeof body === 'object' ? (body.code ?? body.message) : body,
    };
  }
  throw new Error('Mong có lỗi nhưng không');
}

/** Chạy một câu SQL mà dự kiến vỡ, không làm hỏng transaction của test. */
async function sqlLoi(text: string, params: unknown[] = []): Promise<string> {
  await q('SAVEPOINT thu');
  try {
    await q(text, params);
  } catch (e) {
    await q('ROLLBACK TO SAVEPOINT thu');
    return (e as { constraint?: string; message: string }).constraint ?? (e as Error).message;
  }
  await q('RELEASE SAVEPOINT thu');
  throw new Error('Mong SQL vỡ nhưng không');
}

beforeAll(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!t.rows[0]) throw new Error('Cần dữ liệu seed. Chạy: pnpm db:seed');
  tenantA = t.rows[0].id;
  owner = (
    await c.query<{ identity_id: string }>(
      `SELECT identity_id FROM tenant_user WHERE tenant_id = $1 AND role = 'OWNER' LIMIT 1`,
      [tenantA],
    )
  ).rows[0]!.identity_id;

  tdb = new TenantDb(savepointKysely(c));
  const commission = new CommissionService();
  consumption = new SessionConsumptionService(commission);
  sale = new SaleService(tdb, commission);
  billing = new BillingService(tdb, commission);
  members = new MemberService(tdb);
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

type HopDong = { memberId: string; trainerId: string; packageId: string; invoiceId: string };

/** Bán một gói 2 buổi / 1.000.000đ — đủ nhỏ để dùng hết trong test. */
async function banGoi2Buoi(): Promise<HopDong> {
  const r = (
    await q<{ member_id: string; trainer_id: string }>(
      `SELECT m.id AS member_id, tr.id AS trainer_id FROM member m CROSS JOIN trainer tr
        WHERE m.status = 'ACTIVE' AND tr.status = 'ACTIVE' ORDER BY m.code, tr.code LIMIT 1`,
    )
  ).rows[0]!;
  const tpl = await q<{ id: string }>(
    `INSERT INTO package_template (tenant_id, code, name, kind, sessions, valid_days, price)
     VALUES ($1, 'TEST-GIFT-' || floor(random() * 1e9)::text, 'Gói thử tặng buổi', 'PT', 2, 30, 1000000)
     RETURNING id`,
    [tenantA],
  );
  const ban = await asOwner(() =>
    sale.sell({
      memberId: r.member_id,
      templateId: tpl.rows[0]!.id,
      trainerId: r.trainer_id,
      discount: 0,
      installments: [],
    }),
  );
  return { memberId: r.member_id, trainerId: r.trainer_id, packageId: ban.memberPackageId, invoiceId: ban.invoiceId };
}

/** Một buổi đã qua của hợp đồng (năm 2001 — không vướng lịch dev), rồi trừ buổi. */
let gioThu = 0;
async function tapMotBuoi(h: HopDong) {
  const gio = new Date(Date.UTC(2001, 0, 1, ++gioThu * 2));
  const b = await q<{ id: string }>(
    `INSERT INTO booking (tenant_id, member_package_id, member_id, trainer_id, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + interval '1 hour') RETURNING id`,
    [tenantA, h.packageId, h.memberId, h.trainerId, gio],
  );
  const bookingId = b.rows[0]!.id;
  return asOwner(() =>
    tdb.run((tx) =>
      consumption.consume(tx, {
        bookingId,
        memberPackageId: h.packageId,
        trainerId: h.trainerId,
        memberId: h.memberId,
        lyDo: 'CHECKIN',
        xayRaLuc: gio,
      }),
    ),
  );
}

const soDu = async (id: string) =>
  (
    await q<{ sessions_total: number; sessions_bonus: number; sessions_remaining: number; expires_on: string }>(
      `SELECT sessions_total, sessions_bonus, sessions_remaining, expires_on::text FROM member_package WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

describe('Tặng buổi', () => {
  it('chỉ chủ phòng / quản lý gọi được', () => {
    const roles = new Reflector().get<TenantRole[]>(ROLES, MemberController.prototype.gift as () => unknown);
    expect([...roles].sort()).toEqual(['ADMIN', 'OWNER']);
  });

  it('cộng buổi qua sổ cái, ghi người tặng + lý do + nhật ký', async () => {
    const h = await banGoi2Buoi();
    const kq = await asOwner(() =>
      members.giftSessions(h.memberId, h.packageId, { sessions: 3, reason: 'Bù buổi HLV nghỉ đột xuất' }),
    );
    expect(kq).toMatchObject({ sessionsBonus: 3, sessionsRemaining: 5 });
    expect(await soDu(h.packageId)).toMatchObject({ sessions_total: 2, sessions_bonus: 3, sessions_remaining: 5 });

    const sl = await q<{ delta: number; note: string; created_by: string }>(
      `SELECT delta, note, created_by FROM session_ledger WHERE member_package_id = $1 AND reason = 'BONUS'`,
      [h.packageId],
    );
    expect(sl.rows).toEqual([{ delta: 3, note: 'Bù buổi HLV nghỉ đột xuất', created_by: owner }]);

    const al = await q(`SELECT actor_id FROM audit_log WHERE action = 'SESSIONS_GIFTED' AND entity_id = $1`, [
      h.packageId,
    ]);
    expect(al.rows).toEqual([{ actor_id: owner }]);

    const ct = await asOwner(() => members.detail(h.memberId));
    expect(ct.packages.find((p) => p.id === h.packageId)).toMatchObject({ sessionsTotal: 2, sessionsBonus: 3 });
  });

  it('CSDL chặn dòng BONUS không lý do / không người tặng / số âm', async () => {
    const h = await banGoi2Buoi();
    const chen = (delta: number, note: string | null, by: string | null) =>
      sqlLoi(
        `INSERT INTO session_ledger (tenant_id, member_package_id, delta, reason, note, created_by)
         VALUES ($1, $2, $3, 'BONUS', $4, $5)`,
        [tenantA, h.packageId, delta, note, by],
      );
    expect(await chen(1, null, owner)).toBe('ledger_bonus_accountable');
    expect(await chen(1, 'ok', owner)).toBe('ledger_bonus_accountable');
    expect(await chen(1, 'Tặng sinh nhật', null)).toBe('ledger_bonus_accountable');
    expect(await chen(-1, 'Thu hồi buổi tặng', owner)).toBe('ledger_bonus_accountable');
  });

  it('hợp đồng đã huỷ: không tặng', async () => {
    const h = await banGoi2Buoi();
    await q(`UPDATE member_package SET status = 'CANCELLED' WHERE id = $1`, [h.packageId]);
    expect(
      await loi(asOwner(() => members.giftSessions(h.memberId, h.packageId, { sessions: 1, reason: 'Tặng thử' }))),
    ).toEqual({ status: 400, code: 'PACKAGE_NOT_GIFTABLE' });
  });

  it('hợp đồng của hội viên khác: 404', async () => {
    const h = await banGoi2Buoi();
    const khac = (await q<{ id: string }>(`SELECT id FROM member WHERE id <> $1 LIMIT 1`, [h.memberId])).rows[0]!;
    expect(
      await loi(asOwner(() => members.giftSessions(khac.id, h.packageId, { sessions: 1, reason: 'Tặng thử' }))),
    ).toMatchObject({ status: 404 });
  });

  it('hợp đồng quá hạn: phải gia hạn kèm; gia hạn tính từ hôm nay', async () => {
    const h = await banGoi2Buoi();
    await q(`UPDATE member_package SET starts_on = current_date - 60, expires_on = current_date - 10 WHERE id = $1`, [
      h.packageId,
    ]);
    expect(
      await loi(asOwner(() => members.giftSessions(h.memberId, h.packageId, { sessions: 1, reason: 'Bù buổi nghỉ' }))),
    ).toEqual({ status: 400, code: 'PACKAGE_EXPIRED_NEEDS_EXTENSION' });

    const kq = await asOwner(() =>
      members.giftSessions(h.memberId, h.packageId, { sessions: 1, reason: 'Bù buổi nghỉ', extendDays: 14 }),
    );
    const homNay = (
      await q<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 14)::text AS d`)
    ).rows[0]!.d;
    expect(kq.expiresOn).toBe(homNay);
  });

  it('dùng được hết buổi tặng, không hơn; buổi tặng doanh thu 0 nhưng hoa hồng % vẫn có cơ sở', async () => {
    const h = await banGoi2Buoi();
    await asOwner(() => members.giftSessions(h.memberId, h.packageId, { sessions: 1, reason: 'Tặng sinh nhật' }));

    const b1 = await tapMotBuoi(h);
    const b2 = await tapMotBuoi(h);
    const b3 = await tapMotBuoi(h); // buổi tặng — trước 0022 vỡ mp_sessions_range ở đây
    expect([b1.revenueRecognized, b2.revenueRecognized, b3.revenueRecognized]).toEqual([500000, 500000, 0]);
    expect(b3).toMatchObject({ sessionsRemaining: 0, sessionsTotal: 3 });

    const ce = await q<{ base_amount: string }>(
      `SELECT base_amount FROM commission_entry WHERE member_package_id = $1 AND kind = 'TEACH' ORDER BY earned_at`,
      [h.packageId],
    );
    expect(ce.rows.map((r) => Number(r.base_amount))).toEqual([500000, 500000, 500000]);

    // Tổng doanh thu đúng bằng giá hợp đồng — điều v_revenue_over_contract gác.
    const tong = await q<{ s: string }>(`SELECT sum(amount) AS s FROM revenue_entry WHERE member_package_id = $1`, [
      h.packageId,
    ]);
    expect(Number(tong.rows[0]!.s)).toBe(1000000);

    await q('SAVEPOINT qua');
    await expect(tapMotBuoi(h)).rejects.toThrow();
    await q('ROLLBACK TO SAVEPOINT qua');
  });

  it('huỷ hoá đơn đảo về 0 cả buổi tặng', async () => {
    const h = await banGoi2Buoi();
    await asOwner(() => members.giftSessions(h.memberId, h.packageId, { sessions: 2, reason: 'Khuyến mãi khai trương' }));
    await asOwner(() => billing.voidInvoice(h.invoiceId, 'Lập nhầm hội viên'));
    const sau = await q<{ status: string; sessions_remaining: number }>(
      `SELECT status, sessions_remaining FROM member_package WHERE id = $1`,
      [h.packageId],
    );
    expect(sau.rows[0]).toEqual({ status: 'CANCELLED', sessions_remaining: 0 });
  });
});
