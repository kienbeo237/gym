/**
 * Batch C: hội viên tự đặt lịch (khung giờ trống, đổi giờ), hồ sơ hội viên /
 * PT cho màn sửa, hoa hồng đổi hai lần trong ngày, hoá đơn PDF.
 *
 * Cùng cách dựng với phase8-ops.spec.ts: service thật trên MỘT kết nối đang mở
 * transaction ngoài, transaction của Kysely thành SAVEPOINT, đóng vai app_rw
 * nên RLS áp như API thật. Mỗi test rollback sạch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { requestContext } from '../src/common/tenant-context';
import { CommissionService } from '../src/commission/commission.service';
import { SessionConsumptionService } from '../src/attendance/session-consumption.service';
import { BookingService } from '../src/attendance/booking.service';
import { SaleService } from '../src/sale/sale.service';
import { BillingService } from '../src/billing/billing.service';
import { InvoicePdfService } from '../src/billing/invoice-pdf.service';
import { MemberService } from '../src/member/member.service';
import { TrainerService } from '../src/trainer/trainer.service';

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

let booking: BookingService;
let sale: SaleService;
let members: MemberService;
let trainers: TrainerService;
let pdf: InvoicePdfService;

const asOwner = <T>(fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, identityId: owner, roles: ['OWNER'], requestId: 'test' }, fn);
const asMember = <T>(memberId: string, identityId: string, fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, identityId, roles: ['MEMBER'], memberId, requestId: 'test-m' }, fn);

const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

const homNayVN = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);

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
  booking = new BookingService(tdb, new SessionConsumptionService(commission));
  sale = new SaleService(tdb, commission);
  const billing = new BillingService(tdb, commission);
  members = new MemberService(tdb);
  trainers = new TrainerService(tdb);
  pdf = new InvoicePdfService(billing, tdb);
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

type Goi = { memberPackageId: string; invoiceId: string; memberId: string; identityId: string; trainerId: string; price: number };

/**
 * Bán gói PT cho một hội viên chưa có buổi nào sắp tới, với một PT rảnh cả tuần
 * tới — để khung giờ trống không phụ thuộc dữ liệu dev đang có.
 */
async function banGoi(tranhMember?: string): Promise<Goi> {
  const { rows } = await q<{ member_id: string; identity_id: string; trainer_id: string }>(
    `SELECT m.id AS member_id, m.identity_id, tr.id AS trainer_id
       FROM member m CROSS JOIN trainer tr
      WHERE tr.status = 'ACTIVE' AND m.status = 'ACTIVE'
        AND ($1::uuid IS NULL OR m.id <> $1::uuid)
        AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.member_id = m.id AND b.starts_at > now() - interval '1 day')
        AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.trainer_id = tr.id AND b.starts_at > now() - interval '1 day')
      ORDER BY m.code, tr.code
      LIMIT 1`,
    [tranhMember ?? null],
  );
  const r = rows[0];
  if (!r) throw new Error('Không tìm được hội viên/PT rảnh trong dữ liệu seed');
  const tpl = (
    await q<{ id: string; price: string }>(
      `SELECT id, price FROM package_template WHERE kind = 'PT' AND is_active AND sessions >= 3 ORDER BY price LIMIT 1`,
    )
  ).rows[0]!;
  // Chính sách đặt lịch theo phòng, không theo gói mẫu (test tự chỉnh khi cần).
  await q(`UPDATE package_template SET late_cancel_hours = NULL WHERE id = $1`, [tpl.id]);
  const res = await asOwner(() =>
    sale.sell({ memberId: r.member_id, templateId: tpl.id, trainerId: r.trainer_id, discount: 0, installments: [] }),
  );
  return {
    memberPackageId: res.memberPackageId,
    invoiceId: res.invoiceId,
    memberId: r.member_id,
    identityId: r.identity_id,
    trainerId: r.trainer_id,
    price: Number(tpl.price),
  };
}

const khungTrong = async (g: Goi) =>
  (
    await asOwner(() =>
      booking.slots({ memberPackageId: g.memberPackageId, from: homNayVN(), days: 7, durationMinutes: 60 }),
    )
  ).days.flatMap((d) => d.slots);

describe('Hội viên chỉ đặt được bằng gói của chính mình', () => {
  it('xem khung giờ / đặt / đổi giờ trên gói người khác -> 403', async () => {
    const a = await banGoi();
    const b = await banGoi(a.memberId);
    const slot = (await khungTrong(a))[0]!;

    expect(
      await loi(asMember(b.memberId, b.identityId, () =>
        booking.slots({ memberPackageId: a.memberPackageId, from: homNayVN(), days: 7, durationMinutes: 60 }))),
    ).toMatchObject({ status: 403 });
    expect(
      await loi(asMember(b.memberId, b.identityId, () =>
        booking.create({ memberPackageId: a.memberPackageId, startsAt: slot.startsAt, durationMinutes: 60 }))),
    ).toMatchObject({ status: 403 });

    const bk = await asMember(a.memberId, a.identityId, () =>
      booking.create({ memberPackageId: a.memberPackageId, startsAt: slot.startsAt, durationMinutes: 60 }),
    );
    expect(
      await loi(asMember(b.memberId, b.identityId, () => booking.reschedule(bk.id, { startsAt: slot.endsAt }))),
    ).toMatchObject({ status: 403 });
  });

  it('không đặt giờ đã qua, không tự chọn PT khác', async () => {
    const a = await banGoi();
    const slot = (await khungTrong(a))[0]!;
    const ptKhac = (
      await q<{ id: string }>(`SELECT id FROM trainer WHERE status = 'ACTIVE' AND id <> $1 LIMIT 1`, [a.trainerId])
    ).rows[0]!.id;

    expect(
      await loi(asMember(a.memberId, a.identityId, () =>
        booking.create({
          memberPackageId: a.memberPackageId,
          startsAt: new Date(Date.now() - 3 * 3600e3).toISOString(),
          durationMinutes: 60,
        }))),
    ).toMatchObject({ status: 400, code: 'BOOKING_IN_PAST' });
    expect(
      await loi(asMember(a.memberId, a.identityId, () =>
        booking.create({ memberPackageId: a.memberPackageId, trainerId: ptKhac, startsAt: slot.startsAt, durationMinutes: 60 }))),
    ).toMatchObject({ status: 403, code: 'TRAINER_NOT_ALLOWED' });
  });
});

describe('Khung giờ trống', () => {
  it('chỉ tương lai, bỏ khung đã có người đặt, và đếm buổi còn đặt được', async () => {
    const a = await banGoi();
    const truoc = await asOwner(() =>
      booking.slots({ memberPackageId: a.memberPackageId, from: homNayVN(), days: 7, durationMinutes: 60 }),
    );
    const cac = truoc.days.flatMap((d) => d.slots);
    expect(cac.length).toBeGreaterThan(1);
    expect(cac.every((s) => new Date(s.startsAt).getTime() > Date.now())).toBe(true);
    expect(truoc.trainerId).toBe(a.trainerId);

    const chon = cac[Math.floor(cac.length / 2)]!;
    await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: chon.startsAt, durationMinutes: 60 }));

    const sau = await asOwner(() =>
      booking.slots({ memberPackageId: a.memberPackageId, from: homNayVN(), days: 7, durationMinutes: 60 }),
    );
    const bd = new Date(chon.startsAt).getTime();
    const kt = new Date(chon.endsAt).getTime();
    // Không khung nào chồng lên buổi vừa đặt — không chỉ riêng khung trùng khít.
    expect(
      sau.days.flatMap((d) => d.slots).some((s) => new Date(s.startsAt).getTime() < kt && new Date(s.endsAt).getTime() > bd),
    ).toBe(false);
    expect(sau.bookableSessions).toBe(truoc.bookableSessions - 1);
  });
});

describe('Đổi giờ buổi tập', () => {
  it('nhân viên đổi được; không trừ buổi; có nhật ký', async () => {
    const a = await banGoi();
    const cac = await khungTrong(a);
    const cu = cac[0]!;
    const moi = cac.find((s) => new Date(s.startsAt).getTime() >= new Date(cu.endsAt).getTime() + 3600e3)!;
    const bk = await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: cu.startsAt, durationMinutes: 60 }));
    const conTruoc = (await q<{ n: number }>(`SELECT sessions_remaining AS n FROM member_package WHERE id = $1`, [a.memberPackageId])).rows[0]!.n;

    const r = await asOwner(() => booking.reschedule(bk.id, { startsAt: moi.startsAt, reason: 'PT bận' }));
    expect(r.startsAt).toBe(new Date(moi.startsAt).toISOString());
    expect(new Date(r.endsAt).getTime() - new Date(r.startsAt).getTime()).toBe(60 * 60_000);

    const row = (await q<{ status: string; n: number }>(
      `SELECT b.status, mp.sessions_remaining AS n FROM booking b JOIN member_package mp ON mp.id = b.member_package_id WHERE b.id = $1`,
      [bk.id],
    )).rows[0]!;
    expect(row).toEqual({ status: 'BOOKED', n: conTruoc });
    const nk = await q(`SELECT 1 FROM audit_log WHERE action = 'BOOKING_RESCHEDULED' AND entity_id = $1`, [bk.id]);
    expect(nk.rowCount).toBe(1);
  });

  it('hội viên trong khung huỷ muộn -> RESCHEDULE_TOO_LATE; ngoài khung thì được', async () => {
    const a = await banGoi();
    const cac = await khungTrong(a);
    const bk = await asMember(a.memberId, a.identityId, () =>
      booking.create({ memberPackageId: a.memberPackageId, startsAt: cac[0]!.startsAt, durationMinutes: 60 }),
    );
    const moi = cac[cac.length - 1]!;
    const tpl = (await q<{ id: string }>(`SELECT template_id AS id FROM member_package WHERE id = $1`, [a.memberPackageId])).rows[0]!.id;

    await q(`UPDATE package_template SET late_cancel_hours = 10000 WHERE id = $1`, [tpl]);
    // Màn hình đọc khung huỷ muộn từ chính buổi tập — phải là số ĐÃ GỘP chính sách gói.
    expect((await asMember(a.memberId, a.identityId, () => booking.get(bk.id))).lateCancelHours).toBe(10000);
    expect(
      await loi(asMember(a.memberId, a.identityId, () => booking.reschedule(bk.id, { startsAt: moi.startsAt }))),
    ).toMatchObject({ status: 400, code: 'RESCHEDULE_TOO_LATE' });

    await q(`UPDATE package_template SET late_cancel_hours = 0 WHERE id = $1`, [tpl]);
    const r = await asMember(a.memberId, a.identityId, () => booking.reschedule(bk.id, { startsAt: moi.startsAt }));
    expect(r.startsAt).toBe(new Date(moi.startsAt).toISOString());
  });

  it('trùng giờ buổi khác của PT -> TRAINER_BUSY, buổi cũ giữ nguyên', async () => {
    const a = await banGoi();
    const cac = await khungTrong(a);
    const x = cac[0]!;
    const y = cac.find((s) => new Date(s.startsAt).getTime() >= new Date(x.endsAt).getTime())!;
    const b1 = await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: x.startsAt, durationMinutes: 60 }));
    await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: y.startsAt, durationMinutes: 60 }));

    const e = await loi(asOwner(() => booking.reschedule(b1.id, { startsAt: y.startsAt })));
    expect(e.status).toBe(400);
    expect(['TRAINER_BUSY', 'MEMBER_BUSY']).toContain(e.code);
    const r = (await q<{ s: Date }>(`SELECT starts_at AS s FROM booking WHERE id = $1`, [b1.id])).rows[0]!;
    expect(new Date(r.s).toISOString()).toBe(new Date(x.startsAt).toISOString());
  });

  it('buổi đã huỷ không đổi giờ được', async () => {
    const a = await banGoi();
    const cac = await khungTrong(a);
    const bk = await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: cac[0]!.startsAt, durationMinutes: 60 }));
    await asOwner(() => booking.cancel(bk.id, { reason: 'Khách báo bận', by: 'STAFF' }));
    expect(await loi(asOwner(() => booking.reschedule(bk.id, { startsAt: cac[1]!.startsAt })))).toMatchObject({
      status: 400,
      code: 'BOOKING_NOT_RESCHEDULABLE',
    });
  });
});

describe('Hồ sơ hội viên', () => {
  it('chi tiết có gói, buổi đã đặt và còn nợ', async () => {
    const a = await banGoi();
    const cac = await khungTrong(a);
    await asOwner(() => booking.create({ memberPackageId: a.memberPackageId, startsAt: cac[0]!.startsAt, durationMinutes: 60 }));

    const d = await asOwner(() => members.detail(a.memberId));
    const g = d.packages.find((p) => p.id === a.memberPackageId)!;
    expect(g).toMatchObject({ status: 'ACTIVE', sessionsBooked: 1, outstanding: a.price, trainerId: a.trainerId });
    expect(d.packages[0]!.status).toBe('ACTIVE');
  });

  it('sửa hồ sơ có nhật ký; body rỗng không lỗi', async () => {
    const a = await banGoi();
    await asOwner(() => members.update(a.memberId, { note: 'Đau gối trái', gender: 'MALE' }));
    const d = await asOwner(() => members.detail(a.memberId));
    expect(d).toMatchObject({ note: 'Đau gối trái', gender: 'MALE' });
    await asOwner(() => members.update(a.memberId, {}));
    const nk = await q(`SELECT 1 FROM audit_log WHERE action = 'MEMBER_UPDATED' AND entity_id = $1`, [a.memberId]);
    expect(nk.rowCount).toBe(1);
  });
});

describe('Hoa hồng PT', () => {
  it('đổi hai lần trong một ngày: không vỡ ràng buộc, chỉ một bản mở, chi tiết hiện số mới nhất', async () => {
    const tid = (await q<{ id: string }>(`SELECT id FROM trainer WHERE status = 'ACTIVE' LIMIT 1`)).rows[0]!.id;
    await asOwner(() =>
      trainers.update(tid, { commission: { salePct: 7, teachMode: 'FIXED', teachFixedAmount: 150_000, teachPct: 0 } }),
    );
    await asOwner(() =>
      trainers.update(tid, { commission: { salePct: 9, teachMode: 'PCT', teachFixedAmount: 0, teachPct: 40 } }),
    );

    const mo = await q<{ sale_pct: string; tuong_lai: boolean }>(
      `SELECT sale_pct, effective_from > current_date AS tuong_lai FROM commission_policy
        WHERE trainer_id = $1 AND package_template_id IS NULL AND effective_to IS NULL`,
      [tid],
    );
    expect(mo.rows).toEqual([{ sale_pct: expect.stringMatching(/^9(\.0+)?$/), tuong_lai: true }]);

    const d = await asOwner(() => trainers.detail(tid));
    expect(d.commission).toMatchObject({ salePct: 9, teachMode: 'PCT', teachPct: 40 });
  });

  it('chỉ đổi hoa hồng (không trường hồ sơ nào) không lỗi SQL', async () => {
    const tid = (await q<{ id: string }>(`SELECT id FROM trainer WHERE status = 'ACTIVE' LIMIT 1`)).rows[0]!.id;
    await expect(
      asOwner(() => trainers.update(tid, { commission: { salePct: 5, teachMode: 'FIXED', teachFixedAmount: 100_000, teachPct: 0 } })),
    ).resolves.toBeUndefined();
  });
});

describe('Hoá đơn PDF', () => {
  it('là PDF thật; hội viên chỉ tải được của mình (người khác: 404)', async () => {
    const a = await banGoi();
    const b = await banGoi(a.memberId);

    const r = await asOwner(() => pdf.build(a.invoiceId));
    expect(r.pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(r.pdf.length).toBeGreaterThan(5_000);

    await expect(asMember(a.memberId, a.identityId, () => pdf.build(a.invoiceId))).resolves.toBeTruthy();
    expect(await loi(asMember(b.memberId, b.identityId, () => pdf.build(a.invoiceId)))).toMatchObject({ status: 404 });
  });
});
