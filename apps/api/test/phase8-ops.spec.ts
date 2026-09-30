/**
 * Phase 8 (0018): lượt quét buổi tập, tự phân bổ tiền trả góp, mở lại bảng
 * lương, đối soát định kỳ.
 *
 * Khác các spec khác: ở đây gọi THẲNG service thật (logic nằm ở TypeScript,
 * không nằm trong SQL). Để vẫn rollback được như mọi spec, service chạy trên
 * MỘT kết nối đang mở transaction ngoài; `begin/commit/rollback` mà Kysely gửi
 * được đổi thành SAVEPOINT. Kết nối đóng vai app_rw (SET LOCAL ROLE) nên RLS
 * vẫn áp y như API thật; chỉ lúc đọc view đối soát mới trở lại role gốc.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '@pt/contracts';
import { ReopenPayrollRequest } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { requestContext } from '../src/common/tenant-context';
import { CommissionService } from '../src/commission/commission.service';
import { SessionConsumptionService } from '../src/attendance/session-consumption.service';
import { BookingService } from '../src/attendance/booking.service';
import { SaleService } from '../src/sale/sale.service';
import { BillingService } from '../src/billing/billing.service';
import { PayrollService } from '../src/report/payroll.service';
import { PlatformDb, VIEW_DOI_SOAT } from '../src/platform/platform-db.service';

config({ path: resolve(__dirname, '../../../.env') });

/** Pool một kết nối: transaction của Kysely thành savepoint trong transaction ngoài. */
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

let c: Client; // pt_migrator, đóng vai app_rw trong transaction
let db: Kysely<DB>;
let tenantA: string;
let owner: string;

let booking: BookingService;
let sale: SaleService;
let billing: BillingService;
let payroll: PayrollService;

const asOwner = <T>(fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, identityId: owner, roles: ['OWNER'], requestId: 'test' }, fn);
/** Như worker: có tenant, không có người — actor ghi NULL. */
const asSystem = <T>(fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, identityId: '', roles: [], requestId: 'test-worker' }, fn);

/** Chạy SQL thô với quyền app_rw, tenant A. */
const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

/** Tám view đối soát phải rỗng — đọc bằng role gốc rồi trả lại app_rw. */
async function kiemDoiSoat() {
  await c.query('RESET ROLE');
  try {
    const lech: Record<string, number> = {};
    for (const v of VIEW_DOI_SOAT) {
      const { rows } = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${v}`);
      if (rows[0]!.n > 0) lech[v] = rows[0]!.n;
    }
    expect(lech, 'Có view đối soát lệch sau thao tác').toEqual({});
  } finally {
    await c.query('SET LOCAL ROLE app_rw');
  }
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

  db = savepointKysely(c);
  const tdb = new TenantDb(db);
  const commission = new CommissionService();
  booking = new BookingService(tdb, new SessionConsumptionService(commission));
  sale = new SaleService(tdb, commission);
  billing = new BillingService(tdb, commission);
  payroll = new PayrollService(tdb);
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

/** Hội viên + PT không có buổi nào quanh hôm nay (tránh EXCLUDE chồng giờ với dữ liệu dev). */
async function chonNguoi() {
  const { rows } = await q<{ member_id: string; trainer_id: string }>(`
    SELECT m.id AS member_id, tr.id AS trainer_id
      FROM member m CROSS JOIN trainer tr
     WHERE tr.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.member_id = m.id AND b.starts_at > now() - interval '2 days' AND b.starts_at < now() + interval '1 day')
       AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.trainer_id = tr.id AND b.starts_at > now() - interval '2 days' AND b.starts_at < now() + interval '1 day')
     LIMIT 1`);
  if (!rows[0]) throw new Error('Không tìm được hội viên/PT rảnh trong dữ liệu seed');
  return rows[0];
}

async function banGoi(opts: { installments?: { dueDate: string; amount: number }[] } = {}) {
  const { member_id, trainer_id } = await chonNguoi();
  const tpl = (
    await q<{ id: string; price: string }>(
      `SELECT id, price FROM package_template WHERE kind = 'PT' AND is_active AND sessions >= 3 AND price >= 300000 ORDER BY price LIMIT 1`,
    )
  ).rows[0]!;
  // Đưa chính sách về mặc định của phòng: kết quả không phụ thuộc gói mẫu.
  await q(`UPDATE package_template SET no_show_deducts = NULL WHERE id = $1`, [tpl.id]);
  const price = Number(tpl.price);
  const res = await asOwner(() =>
    sale.sell({
      memberId: member_id,
      templateId: tpl.id,
      trainerId: trainer_id,
      discount: 0,
      installments: opts.installments?.length ? opts.installments : [],
    }),
  );
  return { ...res, price, memberId: member_id, trainerId: trainer_id };
}

async function datBuoi(
  g: { memberPackageId: string; memberId: string; trainerId: string },
  startsAt: Date,
  status: 'BOOKED' | 'CHECKED_IN',
) {
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  const { rows } = await q<{ id: string }>(
    `INSERT INTO booking (tenant_id, member_package_id, member_id, trainer_id, starts_at, ends_at, status, checkin_at, checkin_method)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      tenantA, g.memberPackageId, g.memberId, g.trainerId, startsAt, endsAt, status,
      status === 'CHECKED_IN' ? startsAt : null, status === 'CHECKED_IN' ? 'ADMIN' : null,
    ],
  );
  return rows[0]!.id;
}

const trangThai = async (id: string) =>
  (await q<{ status: string; deducted: boolean }>(`SELECT status, deducted FROM booking WHERE id = $1`, [id])).rows[0]!;
const conLai = async (mp: string) =>
  Number((await q<{ n: number }>(`SELECT sessions_remaining AS n FROM member_package WHERE id = $1`, [mp])).rows[0]!.n);

// -----------------------------------------------------------------------------

describe('Lượt quét buổi tập (worker)', () => {
  it('buổi đã điểm danh và đã hết giờ -> COMPLETED; buổi chưa hết giờ giữ nguyên', async () => {
    const g = await banGoi();
    const xong = await datBuoi(g, new Date(Date.now() - 3 * 3600_000), 'CHECKED_IN');
    const dangTap = await datBuoi(g, new Date(Date.now() - 30 * 60_000), 'CHECKED_IN');

    const kq = await asSystem(() => booking.sweep());
    expect(kq.completed).toBeGreaterThanOrEqual(1);
    expect((await trangThai(xong)).status).toBe('COMPLETED');
    expect((await trangThai(dangTap)).status).toBe('CHECKED_IN');

    const nk = await q<{ actor_id: string | null }>(
      `SELECT actor_id FROM audit_log WHERE action = 'BOOKING_AUTO_COMPLETED' ORDER BY id DESC LIMIT 1`,
    );
    expect(nk.rows[0]!.actor_id, 'việc của hệ thống: actor NULL').toBeNull();
  });

  it('tự đánh vắng TẮT (mặc định): buổi quá hạn vẫn BOOKED', async () => {
    await q(`UPDATE tenant_policy SET auto_no_show = false`);
    const g = await banGoi();
    const quaHan = await datBuoi(g, new Date(Date.now() - 26 * 3600_000), 'BOOKED');
    const kq = await asSystem(() => booking.sweep());
    expect(kq.noShow).toBe(0);
    expect((await trangThai(quaHan)).status).toBe('BOOKED');
  });

  it('tự đánh vắng BẬT: chỉ buổi quá (ân hạn + 4 giờ); trừ buổi theo chính sách', async () => {
    await q(`UPDATE tenant_policy SET auto_no_show = true, no_show_deducts = true, checkin_grace_minutes = 30`);
    const g = await banGoi();
    const truoc = await conLai(g.memberPackageId);
    const quaHan = await datBuoi(g, new Date(Date.now() - 26 * 3600_000), 'BOOKED');
    // 3 giờ trước: còn trong cửa sổ 30' + 240' — lễ tân có thể vẫn đang xử lý.
    const trongCuaSo = await datBuoi(g, new Date(Date.now() - 3 * 3600_000), 'BOOKED');

    const kq = await asSystem(() => booking.sweep());
    expect(kq.failed).toBe(0);
    expect(await trangThai(quaHan)).toEqual({ status: 'NO_SHOW', deducted: true });
    expect((await trangThai(trongCuaSo)).status).toBe('BOOKED');
    expect(await conLai(g.memberPackageId)).toBe(truoc - 1);
    await kiemDoiSoat();
  });

  it('tự đánh vắng không tự trừ gói đang KHÔNG ACTIVE (máy không tự quyết khoản nợ)', async () => {
    await q(`UPDATE tenant_policy SET auto_no_show = true, no_show_deducts = true`);
    const g = await banGoi();
    const quaHan = await datBuoi(g, new Date(Date.now() - 26 * 3600_000), 'BOOKED');
    await q(`UPDATE member_package SET status = 'FROZEN' WHERE id = $1`, [g.memberPackageId]);
    const truoc = await conLai(g.memberPackageId);

    await asSystem(() => booking.sweep());
    expect(await trangThai(quaHan)).toEqual({ status: 'NO_SHOW', deducted: false });
    expect(await conLai(g.memberPackageId)).toBe(truoc);
    const nk = await q<{ after: { skippedDeduction?: string; auto?: boolean } }>(
      `SELECT after FROM audit_log WHERE action = 'BOOKING_NO_SHOW' AND entity_id = $1`,
      [quaHan],
    );
    expect(nk.rows[0]!.after).toMatchObject({ auto: true, skippedDeduction: 'PACKAGE_NOT_DEDUCTIBLE' });
    await kiemDoiSoat();
  });
});

describe('Thu tiền trả góp: tự phân bổ đợt cũ trước', () => {
  const dot = (price: number) => {
    const moi = Math.floor(price / 3);
    return [
      // Cố ý đưa đợt đến hạn MUỘN lên đầu mảng: thứ tự phân bổ phải theo hạn, không theo thứ tự nhập.
      { dueDate: '2099-03-01', amount: moi },
      { dueDate: '2099-01-01', amount: price - 2 * moi },
      { dueDate: '2099-02-01', amount: moi },
    ];
  };

  it('một khoản thu lấp đợt đến hạn sớm nhất rồi tràn sang đợt kế', async () => {
    const tpl = (await q<{ price: string }>(
      `SELECT price FROM package_template WHERE kind = 'PT' AND is_active AND sessions >= 3 AND price >= 300000 ORDER BY price LIMIT 1`,
    )).rows[0]!;
    const ds = dot(Number(tpl.price));
    const g = await banGoi({ installments: ds });
    const [muon, som, giua] = ds as [typeof ds[0], typeof ds[0], typeof ds[0]];

    const thu = som.amount + Math.floor(giua.amount / 2);
    const r = await asOwner(() => billing.recordPayment(g.invoiceId, { amount: thu, method: 'CASH', idempotencyKey: 'test-alloc-0001' }));
    expect(r.allocations!.map((a) => a.amount)).toEqual([som.amount, Math.floor(giua.amount / 2)]);

    const lich = await q<{ due_date: string; status: string; da: string }>(
      `SELECT to_char(ps.due_date, 'YYYY-MM-DD') AS due_date, ps.status,
              (SELECT coalesce(sum(p.signed_amount), 0) FROM payment p WHERE p.schedule_id = ps.id)::text AS da
         FROM payment_schedule ps WHERE ps.invoice_id = $1 ORDER BY ps.due_date`,
      [g.invoiceId],
    );
    expect(lich.rows.map((x) => [x.due_date, Number(x.da)])).toEqual([
      ['2099-01-01', som.amount],
      ['2099-02-01', Math.floor(giua.amount / 2)],
      ['2099-03-01', 0],
    ]);
    expect(lich.rows[0]!.status).toBe('PAID');

    // Mỗi phần một dòng payment, mỗi dòng đúng một dòng hoa hồng.
    const soDong = await q<{ n: number }>(`SELECT count(*)::int AS n FROM payment WHERE invoice_id = $1`, [g.invoiceId]);
    expect(soDong.rows[0]!.n).toBe(2);
    await kiemDoiSoat();

    // Thu nốt phần còn lại: lấp đợt 2 rồi đợt 3, hoá đơn PAID.
    const conNo = g.price - thu;
    const r2 = await asOwner(() => billing.recordPayment(g.invoiceId, { amount: conNo, method: 'BANK_TRANSFER' }));
    expect(r2.allocations!.map((a) => a.amount)).toEqual([giua.amount - Math.floor(giua.amount / 2), muon.amount]);
    expect(r2.invoiceStatus).toBe('PAID');
    await kiemDoiSoat();
  });

  it('bấm lại cùng khoá: không phần nào bị ghi hai lần', async () => {
    const tpl = (await q<{ price: string }>(
      `SELECT price FROM package_template WHERE kind = 'PT' AND is_active AND sessions >= 3 AND price >= 300000 ORDER BY price LIMIT 1`,
    )).rows[0]!;
    const ds = dot(Number(tpl.price));
    const g = await banGoi({ installments: ds });
    const thu = ds[1]!.amount + 1000;
    const dto = { amount: thu, method: 'CASH' as const, idempotencyKey: 'test-alloc-0002' };

    await asOwner(() => billing.recordPayment(g.invoiceId, dto));
    await expect(asOwner(() => billing.recordPayment(g.invoiceId, dto))).rejects.toMatchObject({
      response: { code: 'PAYMENT_ALREADY_RECORDED' },
    });
    const tong = await q<{ s: string }>(`SELECT sum(signed_amount)::text AS s FROM payment WHERE invoice_id = $1`, [g.invoiceId]);
    expect(Number(tong.rows[0]!.s)).toBe(thu);
  });

  it('chỉ định scheduleId thì KHÔNG phân bổ', async () => {
    const tpl = (await q<{ price: string }>(
      `SELECT price FROM package_template WHERE kind = 'PT' AND is_active AND sessions >= 3 AND price >= 300000 ORDER BY price LIMIT 1`,
    )).rows[0]!;
    const ds = dot(Number(tpl.price));
    const g = await banGoi({ installments: ds });
    const cuoi = (await q<{ id: string }>(
      `SELECT id FROM payment_schedule WHERE invoice_id = $1 ORDER BY due_date DESC LIMIT 1`,
      [g.invoiceId],
    )).rows[0]!.id;
    const r = await asOwner(() => billing.recordPayment(g.invoiceId, { amount: 50000, method: 'CASH', scheduleId: cuoi }));
    expect(r.allocations).toEqual([{ scheduleId: cuoi, seq: null, amount: 50000 }]);
  });
});

describe('Mở lại bảng lương', () => {
  const T1 = '2099-01';
  const T2 = '2099-02';

  it('mở lại trả hoa hồng về "chưa trả"; nhật ký giữ ảnh chụp và lý do', async () => {
    const g = await banGoi();
    await asOwner(() => billing.recordPayment(g.invoiceId, { amount: 200000, method: 'CASH' }));

    await asOwner(() => payroll.close({ month: T1, adjustments: [] }));
    const gan = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM commission_entry ce JOIN payroll_line pl ON pl.id = ce.payroll_line_id
         JOIN payroll_run pr ON pr.id = pl.run_id WHERE pr.period_month = '2099-01-01'`,
    );
    expect(gan.rows[0]!.n).toBeGreaterThan(0);

    const v = await asOwner(() => payroll.reopen({ month: T1, reason: 'Chốt nhầm trước khi nhập điều chỉnh' }));
    expect(v.status).not.toBe('CLOSED');
    const run = await q(`SELECT 1 FROM payroll_run WHERE period_month = '2099-01-01'`);
    expect(run.rowCount).toBe(0);

    const nk = await q<{ after: { reason: string; releasedCommissions: number }; before: { lines: unknown[] } }>(
      `SELECT before, after FROM audit_log WHERE action = 'PAYROLL_REOPENED' ORDER BY id DESC LIMIT 1`,
    );
    expect(nk.rows[0]!.after).toEqual({ reason: 'Chốt nhầm trước khi nhập điều chỉnh', releasedCommissions: gan.rows[0]!.n });
    expect(nk.rows[0]!.before.lines.length).toBeGreaterThan(0);

    // Chốt lại được, và cuốn lại đúng chừng ấy dòng hoa hồng.
    await asOwner(() => payroll.close({ month: T1, adjustments: [] }));
    const lai = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM commission_entry ce JOIN payroll_line pl ON pl.id = ce.payroll_line_id
         JOIN payroll_run pr ON pr.id = pl.run_id WHERE pr.period_month = '2099-01-01'`,
    );
    expect(lai.rows[0]!.n).toBe(gan.rows[0]!.n);
    await kiemDoiSoat();
  });

  it('còn tháng SAU đã chốt thì không mở tháng trước', async () => {
    await asOwner(() => payroll.close({ month: T1, adjustments: [] }));
    await asOwner(() => payroll.close({ month: T2, adjustments: [] }));
    await expect(asOwner(() => payroll.reopen({ month: T1, reason: 'Thử mở ngược thứ tự' }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_LATER_CLOSED' },
    });
    await asOwner(() => payroll.reopen({ month: T2, reason: 'Mở tháng mới nhất trước' }));
    await asOwner(() => payroll.reopen({ month: T1, reason: 'Rồi mới tới tháng trước' }));
  });

  it('đã CHI thì không mở; tháng chưa chốt thì 404', async () => {
    await asOwner(() => payroll.close({ month: T1, adjustments: [] }));
    await asOwner(() => payroll.markPaid(T1));
    await expect(asOwner(() => payroll.reopen({ month: T1, reason: 'Muốn sửa sau khi đã chi' }))).rejects.toMatchObject({
      response: { code: 'PAYROLL_ALREADY_PAID' },
    });
    await expect(asOwner(() => payroll.reopen({ month: '2099-06', reason: 'Tháng chưa từng chốt' }))).rejects.toThrow(
      /PAYROLL_NOT_FOUND/,
    );
  });

  it('lý do dưới 10 ký tự bị từ chối ở hợp đồng API', () => {
    expect(ReopenPayrollRequest.safeParse({ month: T1, reason: 'nhầm' }).success).toBe(false);
    expect(ReopenPayrollRequest.safeParse({ month: T1, reason: '   nhầm    ' }).success).toBe(false);
  });
});

describe('Đối soát định kỳ', () => {
  it('app_rw / app_auth không đọc được view đối soát (chúng bỏ qua RLS)', async () => {
    await c.query('RESET ROLE');
    const { rows } = await c.query<{ v: string; rw: boolean; au: boolean; pf: boolean }>(
      `SELECT v,
              has_table_privilege('app_rw', v, 'SELECT') AS rw,
              has_table_privilege('app_auth', v, 'SELECT') AS au,
              has_table_privilege('app_platform', v, 'SELECT') AS pf
         FROM unnest($1::text[]) AS v`,
      [VIEW_DOI_SOAT],
    );
    for (const r of rows) expect(r, r.v).toMatchObject({ rw: false, au: false, pf: true });
  });

  it('reconciliation_run: app_rw không chạm; nền tảng chỉ ghi thêm, không sửa/xoá', async () => {
    await c.query('RESET ROLE');
    const { rows } = await c.query(
      `SELECT has_table_privilege('app_rw', 'reconciliation_run', 'SELECT') AS rw,
              has_table_privilege('app_platform', 'reconciliation_run', 'INSERT') AS ins,
              has_table_privilege('app_platform', 'reconciliation_run', 'UPDATE') AS upd,
              has_table_privilege('app_platform', 'reconciliation_run', 'DELETE') AS del`,
    );
    expect(rows[0]).toEqual({ rw: false, ins: true, upd: false, del: false });
  });

  it('reconcile() đếm tám view và ghi một lần chạy', async () => {
    await c.query('RESET ROLE');
    await c.query('SET LOCAL ROLE app_platform');
    const kq = await new PlatformDb(db).reconcile();
    expect(Object.keys(kq.counts).sort()).toEqual([...VIEW_DOI_SOAT].sort());
    expect(kq.errors).toEqual({});
    expect(kq.total).toBe(0);
    const { rows } = await c.query<{ total: number }>(`SELECT total FROM reconciliation_run ORDER BY id DESC LIMIT 1`);
    expect(rows[0]!.total).toBe(0);
  });
});
