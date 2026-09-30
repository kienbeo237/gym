/**
 * Điểm danh HỘ (không mã QR): đường thoát cho ca có thật — hội viên quên điện
 * thoại, hỏng camera — nhưng là đường bỏ qua chốt kiểm soát duy nhất giữa "HLV
 * bấm đã dạy" và "hoa hồng dạy được ghi". Nên nó phải để lại đủ dấu vết: lý
 * do, ai bấm, và dòng lịch sử hội viên đọc được.
 *
 * Cùng cách dựng với phase9-self-service.spec.ts: service thật trên MỘT kết nối
 * đang mở transaction ngoài, đóng vai app_rw nên RLS áp như API thật. Mỗi test
 * rollback sạch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB, TenantRole } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { requestContext } from '../src/common/tenant-context';
import { CommissionService } from '../src/commission/commission.service';
import { SessionConsumptionService } from '../src/attendance/session-consumption.service';
import { CheckinService } from '../src/attendance/checkin.service';
import { SaleService } from '../src/sale/sale.service';

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
let checkin: CheckinService;
let sale: SaleService;

const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

const vai = <T>(
  who: { identityId: string; roles: TenantRole[]; trainerId?: string; memberId?: string },
  fn: () => Promise<T>,
) => requestContext.run({ tenantId: tenantA, requestId: 'test', ...who }, fn);

/** Loại lỗi Nest ném ra: kiểm cả HTTP status lẫn mã nghiệp vụ. */
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

  const tdb = new TenantDb(savepointKysely(c));
  const commission = new CommissionService();
  checkin = new CheckinService(tdb, new SessionConsumptionService(commission));
  sale = new SaleService(tdb, commission);
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

type Buoi = {
  bookingId: string;
  memberPackageId: string;
  member: { memberId: string; identityId: string };
  pt: { trainerId: string; identityId: string };
};

/** Bán gói PT rồi đặt một buổi ĐÚNG GIỜ NÀY — nằm trong khung được điểm danh. */
async function buoiHomNay(): Promise<Buoi> {
  const r = (
    await q<{ member_id: string; m_identity: string; trainer_id: string; t_identity: string }>(
      `SELECT m.id AS member_id, m.identity_id AS m_identity, tr.id AS trainer_id, tr.identity_id AS t_identity
         FROM member m CROSS JOIN trainer tr
        WHERE tr.status = 'ACTIVE' AND m.status = 'ACTIVE'
          -- Rảnh quanh giờ này: không thì buổi tạo dưới đây vướng
          -- excl_booking_trainer_overlap với dữ liệu dev đang có.
          AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.trainer_id = tr.id
                            AND b.starts_at < now() + interval '2 hours' AND b.ends_at > now() - interval '1 hour')
          AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.member_id = m.id
                            AND b.starts_at < now() + interval '2 hours' AND b.ends_at > now() - interval '1 hour')
        ORDER BY m.code, tr.code
        LIMIT 1`,
    )
  ).rows[0];
  if (!r) throw new Error('Không có hội viên/PT trong dữ liệu seed');
  const tpl = (
    await q<{ id: string }>(`SELECT id FROM package_template WHERE kind = 'PT' AND is_active ORDER BY price LIMIT 1`)
  ).rows[0]!;
  const ban = await vai({ identityId: owner, roles: ['OWNER'] }, () =>
    sale.sell({ memberId: r.member_id, templateId: tpl.id, trainerId: r.trainer_id, discount: 0, installments: [] }),
  );
  const b = await q<{ id: string }>(
    `INSERT INTO booking (tenant_id, member_package_id, member_id, trainer_id, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, now(), now() + interval '1 hour') RETURNING id`,
    [tenantA, ban.memberPackageId, r.member_id, r.trainer_id],
  );
  return {
    bookingId: b.rows[0]!.id,
    memberPackageId: ban.memberPackageId,
    member: { memberId: r.member_id, identityId: r.m_identity },
    pt: { trainerId: r.trainer_id, identityId: r.t_identity },
  };
}

const asPt = <T>(b: Buoi, fn: () => Promise<T>) =>
  vai({ identityId: b.pt.identityId, roles: ['PT'], trainerId: b.pt.trainerId }, fn);

describe('Điểm danh hộ', () => {
  it('thiếu lý do -> 400, và không trừ buổi', async () => {
    const b = await buoiHomNay();
    expect(await loi(asPt(b, () => checkin.checkIn(b.bookingId, { method: 'PT_CONFIRM' })))).toEqual({
      status: 400,
      code: 'CHECKIN_REASON_REQUIRED',
    });
    const bk = await q<{ status: string }>(`SELECT status FROM booking WHERE id = $1`, [b.bookingId]);
    expect(bk.rows[0]!.status).toBe('BOOKED');
  });

  it('HLV điểm danh hộ: ghi lý do vào buổi, sổ cái hội viên đọc được, và nhật ký', async () => {
    const b = await buoiHomNay();
    const kq = await asPt(b, () =>
      checkin.checkIn(b.bookingId, { method: 'PT_CONFIRM', reason: 'Hội viên quên điện thoại' }),
    );
    expect(kq.status).toBe('CHECKED_IN');

    const bk = await q<{ checkin_method: string; checkin_note: string; checkin_by: string }>(
      `SELECT checkin_method, checkin_note, checkin_by FROM booking WHERE id = $1`,
      [b.bookingId],
    );
    expect(bk.rows[0]).toEqual({
      checkin_method: 'PT_CONFIRM',
      checkin_note: 'Hội viên quên điện thoại',
      checkin_by: b.pt.identityId,
    });

    const sl = await q<{ note: string }>(
      `SELECT note FROM session_ledger WHERE ref_type = 'BOOKING' AND ref_id = $1`,
      [b.bookingId],
    );
    expect(sl.rows[0]!.note).toBe('Huấn luyện viên điểm danh hộ — Hội viên quên điện thoại');

    const al = await q<{ actor_id: string; after: { method: string; reason: string } }>(
      `SELECT actor_id, after FROM audit_log WHERE action = 'CHECKIN_MANUAL' AND entity_id = $1`,
      [b.bookingId],
    );
    expect(al.rows).toHaveLength(1);
    expect(al.rows[0]).toMatchObject({ actor_id: b.pt.identityId, after: { method: 'PT_CONFIRM' } });
  });

  it('phương thức theo VAI người bấm, không theo client khai', async () => {
    const b1 = await buoiHomNay();
    // HLV khai ADMIN ("phòng tập xác nhận") cho buổi mình ăn hoa hồng -> vẫn ghi PT_CONFIRM.
    await asPt(b1, () => checkin.checkIn(b1.bookingId, { method: 'ADMIN', reason: 'Camera điện thoại hỏng' }));
    const r1 = await q<{ checkin_method: string }>(`SELECT checkin_method FROM booking WHERE id = $1`, [b1.bookingId]);
    expect(r1.rows[0]!.checkin_method).toBe('PT_CONFIRM');
  });

  it('chủ phòng điểm danh hộ -> ADMIN, sổ cái ghi "Phòng tập"', async () => {
    const b = await buoiHomNay();
    await vai({ identityId: owner, roles: ['OWNER'] }, () =>
      checkin.checkIn(b.bookingId, { method: 'PT_CONFIRM', reason: 'Máy quét ở quầy hỏng' }),
    );
    const r = await q<{ checkin_method: string }>(`SELECT checkin_method FROM booking WHERE id = $1`, [b.bookingId]);
    expect(r.rows[0]!.checkin_method).toBe('ADMIN');
    const sl = await q<{ note: string }>(`SELECT note FROM session_ledger WHERE ref_id = $1`, [b.bookingId]);
    expect(sl.rows[0]!.note).toMatch(/^Phòng tập điểm danh hộ — /);
  });

  it('HLV khác và hội viên không điểm danh hộ được', async () => {
    const b = await buoiHomNay();
    const ptKhac = (
      await q<{ id: string; identity_id: string }>(
        `SELECT id, identity_id FROM trainer WHERE status = 'ACTIVE' AND id <> $1 LIMIT 1`,
        [b.pt.trainerId],
      )
    ).rows[0]!;
    expect(
      await loi(
        vai({ identityId: ptKhac.identity_id, roles: ['PT'], trainerId: ptKhac.id }, () =>
          checkin.checkIn(b.bookingId, { method: 'PT_CONFIRM', reason: 'Hội viên quên điện thoại' }),
        ),
      ),
    ).toMatchObject({ status: 403 });
    expect(
      await loi(
        vai({ identityId: b.member.identityId, roles: ['MEMBER'], memberId: b.member.memberId }, () =>
          checkin.checkIn(b.bookingId, { method: 'ADMIN', reason: 'Tôi tự điểm danh' }),
        ),
      ),
    ).toMatchObject({ status: 403 });
  });

  it('quét QR vẫn như cũ: không cần lý do, không ghi chú', async () => {
    const b = await buoiHomNay();
    const { token } = await asPt(b, () => checkin.issueToken(b.bookingId));
    await vai({ identityId: b.member.identityId, roles: ['MEMBER'], memberId: b.member.memberId }, () =>
      checkin.checkIn(b.bookingId, { method: 'QR', token }),
    );
    const r = await q<{ checkin_method: string; checkin_note: string | null }>(
      `SELECT checkin_method, checkin_note FROM booking WHERE id = $1`,
      [b.bookingId],
    );
    expect(r.rows[0]).toEqual({ checkin_method: 'QR', checkin_note: null });
  });

  it('CSDL chặn điểm danh hộ không lý do dù đi đường SQL tay', async () => {
    const b = await buoiHomNay();
    await expect(
      q(
        `UPDATE booking SET status = 'CHECKED_IN', checkin_at = now(), checkin_method = 'ADMIN' WHERE id = $1`,
        [b.bookingId],
      ),
    ).rejects.toThrow(/booking_manual_checkin_note/);
  });
});
