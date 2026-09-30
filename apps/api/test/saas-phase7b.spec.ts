/**
 * Phase 7b (0017): yêu cầu đổi gói, webhook ngân hàng, mật khẩu tạm.
 *
 * Như saas-lifecycle.spec.ts: mọi ca chạy trong transaction rồi ROLLBACK, bằng
 * ĐÚNG role mà API dùng (app_rw cho phòng tập, app_platform cho nền tảng).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../.env') });

let pf: Client; // app_platform
let app: Client; // app_rw
let tenantA: string;
let owner: string;

beforeAll(async () => {
  pf = new Client({ connectionString: process.env.DATABASE_URL_PLATFORM });
  app = new Client({ connectionString: process.env.DATABASE_URL_APP });
  await pf.connect();
  await app.connect();
  const t = await pf.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!t.rows[0]) throw new Error('Cần dữ liệu seed. Chạy: pnpm db:seed');
  tenantA = t.rows[0].id;
  owner = (
    await pf.query<{ identity_id: string }>(
      `SELECT identity_id FROM tenant_user WHERE tenant_id = $1 AND role = 'OWNER' LIMIT 1`,
      [tenantA],
    )
  ).rows[0]!.identity_id;
});

afterAll(async () => {
  await pf.end().catch(() => {});
  await app.end().catch(() => {});
});

describe('Yêu cầu đổi gói: phòng tập gửi / huỷ được, KHÔNG tự duyệt được', () => {
  beforeEach(async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    // Phòng A có thể đang có yêu cầu thật đang chờ (dùng thử trên máy dev).
    await app.query(
      `UPDATE plan_change_request SET status = 'CANCELLED', decided_at = now(), decided_by = $1 WHERE status = 'PENDING'`,
      [owner],
    );
  });
  afterEach(async () => {
    await app.query('ROLLBACK');
  });

  const gui = (status = 'PENDING') =>
    app.query<{ id: string }>(
      `INSERT INTO plan_change_request (tenant_id, from_plan, to_plan, requested_by, status, decided_at)
       SELECT $1, s.plan_code, CASE WHEN s.plan_code = 'PRO' THEN 'BASIC' ELSE 'PRO' END, $2, $3,
              CASE WHEN $3 = 'PENDING' THEN NULL ELSE now() END
         FROM tenant_subscription s RETURNING id`,
      [tenantA, owner, status],
    );

  it('gửi PENDING được; gửi thẳng APPROVED thì bị policy chặn', async () => {
    await expect(gui('APPROVED')).rejects.toThrow(/row-level security/i);
  });

  it('huỷ được yêu cầu của mình; tự đặt APPROVED thì không', async () => {
    const { rows } = await gui();
    await app.query('SAVEPOINT a');
    await expect(
      app.query(`UPDATE plan_change_request SET status = 'APPROVED', decided_at = now() WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/row-level security/i);
    await app.query('ROLLBACK TO SAVEPOINT a');
    const r = await app.query(
      `UPDATE plan_change_request SET status = 'CANCELLED', decided_at = now(), decided_by = $2 WHERE id = $1`,
      [rows[0]!.id, owner],
    );
    expect(r.rowCount).toBe(1);
  });

  it('không sửa được gói đích hay ghi chú duyệt (không có quyền cột)', async () => {
    const { rows } = await gui();
    await expect(
      app.query(`UPDATE plan_change_request SET decision_note = 'tự duyệt' WHERE id = $1`, [rows[0]!.id]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('mỗi phòng tối đa MỘT yêu cầu đang chờ', async () => {
    await gui();
    await expect(gui()).rejects.toThrow(/uq_pcr_pending/);
  });
});

describe('Giao dịch ngân hàng: quyền', () => {
  it('app_rw không có quyền gì trên bank_txn_event và không gọi được hàm nhận', async () => {
    const { rows } = await pf.query<{ sel: boolean; ins: boolean; fn: boolean }>(`
      SELECT has_table_privilege('app_rw', 'bank_txn_event', 'SELECT') AS sel,
             has_table_privilege('app_rw', 'bank_txn_event', 'INSERT') AS ins,
             has_function_privilege('app_rw',
               'saas_ingest_bank_txn(text,text,text,bigint,text,text,text,timestamptz,jsonb)', 'EXECUTE') AS fn`);
    expect(rows[0]).toEqual({ sel: false, ins: false, fn: false });
  });

  it('app_platform không XOÁ được giao dịch (bằng chứng tiền vào)', async () => {
    const { rows } = await pf.query<{ del: boolean }>(
      `SELECT has_table_privilege('app_platform', 'bank_txn_event', 'DELETE') AS del`,
    );
    expect(rows[0]!.del).toBe(false);
  });
});

describe('Giao dịch ngân hàng: tự khớp hoá đơn', () => {
  let invoice: { id: string; transfer_ref: string; amount: number };

  beforeEach(async () => {
    await pf.query('BEGIN');
    await pf.query(
      `UPDATE bank_txn_event SET invoice_id = NULL
        WHERE invoice_id IN (SELECT id FROM tenant_billing_record WHERE tenant_id = $1)`,
      [tenantA],
    );
    await pf.query(`DELETE FROM tenant_billing_record WHERE tenant_id = $1 AND bank_event_id IS NULL`, [tenantA]);
    await pf.query(
      `UPDATE tenant_subscription SET plan_code = 'BASIC', status = 'PAST_DUE',
              current_period_start = '2030-09-01', current_period_end = '2030-09-30'
        WHERE tenant_id = $1`,
      [tenantA],
    );
    await pf.query(`UPDATE tenant SET status = 'SUSPENDED', suspend_kind = 'BILLING' WHERE id = $1`, [tenantA]);
    await pf.query(`SELECT saas_issue_invoice($1::uuid, NULL, NULL, NULL)`, [tenantA]);
    const r = await pf.query<{ id: string; transfer_ref: string; amount: string }>(
      `SELECT id, transfer_ref, amount FROM tenant_billing_record WHERE tenant_id = $1 AND status = 'PENDING'`,
      [tenantA],
    );
    invoice = { ...r.rows[0]!, amount: Number(r.rows[0]!.amount) };
  });
  afterEach(async () => {
    await pf.query('ROLLBACK');
  });

  const nhan = async (txnId: string, amount: number, content: string, direction = 'IN') =>
    (
      await pf.query<{ r: { outcome: string; invoiceId: string | null; duplicate: boolean } }>(
        `SELECT saas_ingest_bank_txn('SEPAY', $1, $2, $3::bigint, $4, NULL, NULL, now(), '{}'::jsonb) AS r`,
        [txnId, direction, amount, content],
      )
    ).rows[0]!.r;

  const trangThai = async () =>
    (
      await pf.query<{ b: string; t: string; pe: string; by: string | null; ev: string | null; ref: string | null }>(
        `SELECT b.status AS b, t.status AS t, s.current_period_end::text AS pe, b.confirmed_by AS by,
                b.bank_event_id::text AS ev, b.bank_txn_ref AS ref
           FROM tenant_billing_record b JOIN tenant t ON t.id = b.tenant_id
           JOIN tenant_subscription s ON s.tenant_id = b.tenant_id WHERE b.id = $1`,
        [invoice.id],
      )
    ).rows[0]!;

  it('đúng mã (ngân hàng nuốt dấu cách, thêm tiền tố) + đúng tiền -> PAID, mở khoá, gia hạn', async () => {
    const noiDung = `MBVCB.123456.${invoice.transfer_ref.replace(/ /g, '').toLowerCase()}.CT tu 0123`;
    const r = await nhan('T-1', invoice.amount, noiDung);
    expect(r).toMatchObject({ outcome: 'MATCHED', invoiceId: invoice.id, duplicate: false });
    const s = await trangThai();
    expect(s).toMatchObject({ b: 'PAID', t: 'ACTIVE', pe: '2030-10-31', by: null, ref: 'SEPAY:T-1' });
    expect(s.ev).not.toBeNull();
    const log = await pf.query(
      `SELECT 1 FROM platform_audit_log WHERE action = 'invoice.auto_confirm' AND detail->>'invoiceId' = $1`,
      [invoice.id],
    );
    expect(log.rowCount).toBe(1);
  });

  it('gửi lại cùng mã giao dịch: không tất toán lần hai', async () => {
    await nhan('T-2', invoice.amount, invoice.transfer_ref);
    const lan2 = await nhan('T-2', invoice.amount, invoice.transfer_ref);
    expect(lan2).toMatchObject({ outcome: 'MATCHED', duplicate: true });
    const n = await pf.query(`SELECT 1 FROM bank_txn_event WHERE provider_txn_id = 'T-2'`);
    expect(n.rowCount).toBe(1);
  });

  it('lệch số tiền -> AMOUNT_MISMATCH, hoá đơn vẫn chờ, phòng vẫn khoá', async () => {
    const r = await nhan('T-3', invoice.amount - 1000, invoice.transfer_ref);
    expect(r).toMatchObject({ outcome: 'AMOUNT_MISMATCH', invoiceId: invoice.id });
    expect(await trangThai()).toMatchObject({ b: 'PENDING', t: 'SUSPENDED' });
  });

  it('không có mã nào -> NO_MATCH; tiền ra -> IGNORED', async () => {
    expect((await nhan('T-4', invoice.amount, 'chuyen tien an trua')).outcome).toBe('NO_MATCH');
    expect((await nhan('T-5', invoice.amount, invoice.transfer_ref, 'OUT')).outcome).toBe('IGNORED');
    expect((await trangThai()).b).toBe('PENDING');
  });

  it('chuyển HAI lần cho một hoá đơn: lần hai là ALREADY_SETTLED để người đối soát hoàn tiền', async () => {
    await nhan('T-6', invoice.amount, invoice.transfer_ref);
    const r = await nhan('T-7', invoice.amount, invoice.transfer_ref);
    expect(r).toMatchObject({ outcome: 'ALREADY_SETTLED', invoiceId: invoice.id });
  });

  it('vẫn không có "đã thu" vô danh: PAID không người xác nhận, không dòng sao kê thì bị chặn', async () => {
    await expect(
      pf.query(`UPDATE tenant_billing_record SET status = 'PAID', paid_amount = amount, confirmed_at = now() WHERE id = $1`, [
        invoice.id,
      ]),
    ).rejects.toThrow(/billing_paid_needs_confirmation/);
  });
});
