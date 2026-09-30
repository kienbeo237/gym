/**
 * VÒNG ĐỜI THUÊ BAO SAAS + ranh giới quyền của mặt phẳng nền tảng (0016).
 *
 * Mọi ca chạy trong transaction rồi ROLLBACK: dữ liệu seed không đổi, và ngày
 * "hôm nay" là tham số `p_today` của saas_lifecycle_tick — không phải chờ lịch.
 *
 * Chạy bằng app_platform, ĐÚNG role mà worker và API dùng. Chạy bằng superuser
 * thì phép kiểm "không sửa được nhật ký" xanh giả.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../.env') });

let pf: Client; // app_platform
let app: Client; // app_rw
let tenantA: string;
let actor: string;

beforeAll(async () => {
  pf = new Client({ connectionString: process.env.DATABASE_URL_PLATFORM });
  app = new Client({ connectionString: process.env.DATABASE_URL_APP });
  await pf.connect();
  await app.connect();
  const t = await pf.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!t.rows[0]) throw new Error('Cần dữ liệu seed. Chạy: pnpm db:seed');
  tenantA = t.rows[0].id;
  actor = (await pf.query<{ id: string }>(`SELECT id FROM identity ORDER BY created_at LIMIT 1`)).rows[0]!.id;
});

afterAll(async () => {
  await pf.end().catch(() => {});
  await app.end().catch(() => {});
});

describe('Quyền: phòng tập không tự đổi được gói hay trạng thái', () => {
  it('app_rw KHÔNG sửa được cột status / suspend_kind của tenant, vẫn sửa được tên', async () => {
    const { rows } = await pf.query<{ status: boolean; kind: boolean; name: boolean }>(`
      SELECT has_column_privilege('app_rw', 'tenant', 'status', 'UPDATE')       AS status,
             has_column_privilege('app_rw', 'tenant', 'suspend_kind', 'UPDATE') AS kind,
             has_column_privilege('app_rw', 'tenant', 'name', 'UPDATE')         AS name`);
    expect(rows[0]!.status, 'phòng tập tự mở khoá được cho chính mình').toBe(false);
    expect(rows[0]!.kind).toBe(false);
    expect(rows[0]!.name).toBe(true);
  });

  it('app_rw chỉ ĐỌC được thuê bao và hoá đơn SaaS', async () => {
    for (const bang of ['tenant_subscription', 'tenant_billing_record', 'plan']) {
      const { rows } = await pf.query<{ w: boolean }>(
        `SELECT has_table_privilege('app_rw', $1, 'UPDATE') OR has_table_privilege('app_rw', $1, 'INSERT') AS w`,
        [bang],
      );
      expect(rows[0]!.w, `app_rw ghi được ${bang}`).toBe(false);
    }
  });

  it('app_rw KHÔNG gọi được hàm vòng đời nào', async () => {
    const { rows } = await pf.query<{ proname: string }>(`
      SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname LIKE 'saas\\_%'
        AND has_function_privilege('app_rw', p.oid, 'EXECUTE')`);
    expect(rows.map((r) => r.proname)).toEqual([]);
  });

  it('app_platform CHỈ GHI THÊM được nhật ký nền tảng', async () => {
    await pf.query('BEGIN');
    try {
      await expect(pf.query(`UPDATE platform_audit_log SET action = action`)).rejects.toThrow(/permission denied/i);
    } finally {
      await pf.query('ROLLBACK');
    }
    await pf.query('BEGIN');
    try {
      await expect(pf.query(`DELETE FROM platform_audit_log`)).rejects.toThrow(/permission denied/i);
    } finally {
      await pf.query('ROLLBACK');
    }
  });
});

describe('Vòng đời: dùng thử / đang dùng -> quá hạn -> tạm khoá -> trả tiền -> mở', () => {
  beforeEach(async () => {
    await pf.query('BEGIN');
    // Dựng trạng thái biết trước cho phòng A: gói trả phí, đã trả tới 30/09.
    await pf.query(
      `UPDATE bank_txn_event SET invoice_id = NULL
        WHERE invoice_id IN (SELECT id FROM tenant_billing_record WHERE tenant_id = $1)`,
      [tenantA],
    );
    await pf.query(`DELETE FROM tenant_billing_record WHERE tenant_id = $1`, [tenantA]);
    await pf.query(
      `UPDATE tenant_subscription SET plan_code = 'BASIC', status = 'ACTIVE',
              current_period_start = '2030-09-01', current_period_end = '2030-09-30'
        WHERE tenant_id = $1`,
      [tenantA],
    );
    await pf.query(`UPDATE tenant SET status = 'ACTIVE', suspend_kind = NULL WHERE id = $1`, [tenantA]);
  });
  afterEach(async () => {
    await pf.query('ROLLBACK');
  });

  const tick = async (ngay: string) =>
    (await pf.query<{ r: Record<string, number> }>(`SELECT saas_lifecycle_tick($1::date, 7, 7) AS r`, [ngay])).rows[0]!.r;
  const trangThai = async () =>
    (
      await pf.query<{ t: string; kind: string | null; s: string; pe: string }>(
        `SELECT t.status AS t, t.suspend_kind AS kind, s.status AS s, s.current_period_end::text AS pe
           FROM tenant t JOIN tenant_subscription s ON s.tenant_id = t.id WHERE t.id = $1`,
        [tenantA],
      )
    ).rows[0]!;
  const hoaDon = async () =>
    (
      await pf.query<{ id: string; period_start: string; amount: string; status: string; transfer_ref: string }>(
        `SELECT id, period_start::text, amount::text, status, transfer_ref FROM tenant_billing_record
          WHERE tenant_id = $1 ORDER BY created_at`,
        [tenantA],
      )
    ).rows;

  it('chưa tới 7 ngày trước hạn: không phát hành gì', async () => {
    await tick('2030-09-20');
    expect(await hoaDon()).toEqual([]);
  });

  it('7 ngày trước hạn: phát hành ĐÚNG MỘT hoá đơn kỳ tới, chạy lại không phát hành thêm', async () => {
    await tick('2030-09-24');
    await tick('2030-09-25');
    await tick('2030-09-25');
    const hd = await hoaDon();
    expect(hd).toHaveLength(1);
    expect(hd[0]!.period_start).toBe('2030-10-01');
    expect(hd[0]!.amount).toBe('990000');
    expect(hd[0]!.transfer_ref).toMatch(/^PT3010 [A-Z0-9]+ [0-9A-F]{4}$/);
  });

  it('hết kỳ -> PAST_DUE; quá 7 ngày -> SUSPENDED (BILLING), không sớm hơn', async () => {
    await tick('2030-10-01');
    expect(await trangThai()).toMatchObject({ t: 'PAST_DUE', s: 'PAST_DUE' });
    await tick('2030-10-07');
    expect((await trangThai()).t).toBe('PAST_DUE');
    await tick('2030-10-08');
    expect(await trangThai()).toMatchObject({ t: 'SUSPENDED', kind: 'BILLING' });
  });

  it('trả tiền: gia hạn tới cuối kỳ đã trả và MỞ khoá do nợ', async () => {
    await tick('2030-10-10');
    const [hd] = await hoaDon();
    await pf.query(`SELECT saas_settle_invoice($1, 'PAID', $2, 'FT-TEST', 990000, NULL)`, [hd!.id, actor]);
    expect(await trangThai()).toMatchObject({ t: 'ACTIVE', kind: null, s: 'ACTIVE', pe: '2030-10-31' });
    // Job chạy lại ngay sau đó không được khoá lại.
    await tick('2030-10-10');
    expect((await trangThai()).t).toBe('ACTIVE');
  });

  it('xác nhận HAI lần cùng một hoá đơn: lần hai bị từ chối, không gia hạn hai lần', async () => {
    await tick('2030-09-25');
    const [hd] = await hoaDon();
    await pf.query(`SELECT saas_settle_invoice($1, 'PAID', $2, 'FT-1', 990000, NULL)`, [hd!.id, actor]);
    await pf.query('SAVEPOINT s');
    await expect(
      pf.query(`SELECT saas_settle_invoice($1, 'PAID', $2, 'FT-2', 990000, NULL)`, [hd!.id, actor]),
    ).rejects.toThrow(/INVOICE_NOT_PENDING/);
    await pf.query('ROLLBACK TO SAVEPOINT s');
    expect((await trangThai()).pe).toBe('2030-10-31');
  });

  it('khoá TAY không được mở bởi việc trả tiền', async () => {
    await tick('2030-09-25');
    await pf.query(`UPDATE tenant SET status = 'SUSPENDED', suspend_kind = 'MANUAL' WHERE id = $1`, [tenantA]);
    const [hd] = await hoaDon();
    await pf.query(`SELECT saas_settle_invoice($1, 'PAID', $2, 'FT-3', 990000, NULL)`, [hd!.id, actor]);
    expect(await trangThai()).toMatchObject({ t: 'SUSPENDED', kind: 'MANUAL', s: 'ACTIVE' });
  });

  it('gói 0đ: hết kỳ thì tự sang kỳ mới, không hoá đơn, không quá hạn', async () => {
    await pf.query(`UPDATE tenant_subscription SET plan_code = 'FREE' WHERE tenant_id = $1`, [tenantA]);
    await tick('2030-10-15');
    expect(await hoaDon()).toEqual([]);
    expect(await trangThai()).toMatchObject({ t: 'ACTIVE', s: 'ACTIVE' });
    expect((await trangThai()).pe >= '2030-10-15').toBe(true);
  });

  it('huỷ (VOID) rồi phát hành lại CÙNG kỳ được, với nội dung chuyển khoản không trùng hoá đơn sống', async () => {
    await tick('2030-09-25');
    const [hd] = await hoaDon();
    await pf.query(`UPDATE tenant_billing_record SET status = 'VOID' WHERE id = $1`, [hd!.id]);
    const r = await pf.query<{ id: string | null }>(`SELECT saas_issue_invoice($1, $2, 500000, 'giảm giá') AS id`, [tenantA, actor]);
    expect(r.rows[0]!.id).not.toBeNull();
    const conSong = (await hoaDon()).filter((h) => h.status !== 'VOID');
    expect(conSong).toHaveLength(1);
    expect(conSong[0]!.amount).toBe('500000');
  });

  it('mỗi chuyển trạng thái của hệ thống để lại một dòng nhật ký (actor NULL)', async () => {
    const truoc = Number((await pf.query(`SELECT count(*) FROM platform_audit_log WHERE target_tenant = $1`, [tenantA])).rows[0].count);
    await tick('2030-10-08'); // phát hành + quá hạn + khoá trong một lần
    const { rows } = await pf.query<{ action: string; actor_id: string | null }>(
      `SELECT action, actor_id FROM platform_audit_log WHERE target_tenant = $1 ORDER BY id DESC LIMIT 3`,
      [tenantA],
    );
    expect(rows.map((r) => r.action).sort()).toEqual(
      ['system.invoice.issue', 'system.subscription.past_due', 'system.tenant.suspend'].sort(),
    );
    expect(rows.every((r) => r.actor_id === null)).toBe(true);
    const sau = Number((await pf.query(`SELECT count(*) FROM platform_audit_log WHERE target_tenant = $1`, [tenantA])).rows[0].count);
    expect(sau - truoc).toBe(3);
  });
});

describe('Hạn mức: phòng tập đọc được hạn mức CỦA MÌNH, không của phòng khác', () => {
  it('app_rw đặt phòng A chỉ thấy đúng một thuê bao — của phòng A', async () => {
    await app.query('BEGIN');
    try {
      await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
      const { rows } = await app.query<{ tenant_id: string }>(`SELECT tenant_id FROM tenant_subscription`);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tenant_id).toBe(tenantA);
    } finally {
      await app.query('ROLLBACK');
    }
  });
});
