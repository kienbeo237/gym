/**
 * CỔNG GÁC CÁCH LY TENANT.
 *
 * Đây là test quan trọng nhất của dự án. Nó không kiểm một tính năng — nó kiểm
 * một BẤT BIẾN mà mọi tính năng về sau đều dựa vào: dữ liệu của phòng tập này
 * không thể rơi sang phòng tập khác.
 *
 * Bốn nhóm, mỗi nhóm bắt một lớp lỗi khác nhau:
 *   A. Cấu trúc  — bảng có tenant_id mà quên RLS (lỗi khi thêm migration mới)
 *   B. Đặc quyền — role của app bị cấp SUPERUSER/BYPASSRLS (lỗi khi dựng môi trường)
 *   C. Khoá      — UNIQUE thiếu tenant_id (phòng thứ hai không đặt được mã trùng)
 *   D. Hành vi   — đọc/ghi chéo tenant bằng chính role mà API dùng
 *
 * Nhóm A và C chạy trên catalog nên không cần dữ liệu; nhóm D cần seed hai phòng.
 *
 * CHẠY BẰNG role nào là phần cốt lõi: nhóm D PHẢI dùng app_rw. Chạy bằng
 * pt_migrator (superuser) thì mọi phép kiểm đều xanh và test trở nên vô nghĩa —
 * test này có một ca riêng để chặn đúng việc đó.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../.env') });

/**
 * Bảng KHÔNG có cột tenant_id. Danh sách này cố ý ngắn và cố ý chốt cứng:
 * thêm một dòng ở đây là một quyết định phải giải trình trong pull request,
 * không phải một dòng lặng lẽ trôi qua review.
 */
const GLOBAL_TABLES = new Set([
  'tenant',                  // có policy riêng: id = app.tenant_id
  'identity',                // có policy riêng: qua tenant_user
  'identity_phone_history',  // lịch sử đổi SĐT, chỉ app_auth chạm
  'otp_challenge',           // trước khi có tenant
  'plan',                    // danh mục gói SaaS, dùng chung
  'platform_admin',          // mặt phẳng nền tảng
  'platform_audit_log',      // mặt phẳng nền tảng
  'schema_migrations',       // của migration runner
]);

/**
 * UNIQUE index không chứa tenant_id nhưng vẫn ĐÚNG, kèm lý do.
 * Ba dòng, không hơn — mỗi dòng phải tự giải thích được.
 */
const UNIQUE_INDEX_EXCEPTIONS = new Map([
  ['uq_file_key', 'object_key đã mang tiền tố t/<tenant_id>/, ép bởi CHECK file_key_tenant_prefix'],
  ['refresh_token_token_hash_key', 'sha256 của token ngẫu nhiên 256 bit — duy nhất toàn cục theo bản chất'],
  ['checkin_token_token_hash_key', 'sha256 của token ngẫu nhiên — duy nhất toàn cục theo bản chất'],
]);

let admin: Client;   // pt_migrator: đọc catalog
let app: Client;     // app_rw: role thật của API

beforeAll(async () => {
  admin = new Client({ connectionString: process.env.DATABASE_URL });
  app = new Client({ connectionString: process.env.DATABASE_URL_APP });
  await admin.connect();
  await app.connect();
});

afterAll(async () => {
  await admin.end().catch(() => {});
  await app.end().catch(() => {});
});

// ============================================================================
describe('A. Cấu trúc: mọi bảng có tenant_id đều phải được RLS bảo vệ', () => {
  it('không bảng nào thiếu RLS, FORCE hoặc policy', async () => {
    const { rows } = await admin.query<{
      bang: string; rls: boolean; force: boolean; so_policy: string; co_tenant: boolean;
    }>(`
      SELECT c.relname AS bang,
             c.relrowsecurity      AS rls,
             c.relforcerowsecurity AS force,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS so_policy,
             EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                       AND a.attnum > 0 AND NOT a.attisdropped) AS co_tenant
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`);

    expect(rows.length).toBeGreaterThan(20);

    const hong = rows
      .filter((r) => r.co_tenant)
      .filter((r) => !r.rls || !r.force || Number(r.so_policy) === 0)
      .map((r) => `${r.bang} (rls=${r.rls} force=${r.force} policy=${r.so_policy})`);

    expect(
      hong,
      `Bảng có tenant_id nhưng chưa được bảo vệ.\n` +
        `Thêm vào migration: SELECT enable_tenant_rls('<tên bảng>');\n` +
        hong.join('\n'),
    ).toEqual([]);
  });

  it('danh sách bảng toàn cục đúng như đã khai — không thừa, không thiếu', async () => {
    const { rows } = await admin.query<{ bang: string }>(`
      SELECT c.relname AS bang
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND NOT EXISTS (SELECT 1 FROM pg_attribute a
                        WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
                          AND a.attnum > 0 AND NOT a.attisdropped)
      ORDER BY 1`);

    const thucTe = rows.map((r) => r.bang);
    const laMat = thucTe.filter((t) => !GLOBAL_TABLES.has(t));

    expect(
      laMat,
      `Bảng MỚI không có tenant_id. Gần như chắc chắn là quên cột — nếu thật sự\n` +
        `là bảng dùng chung thì thêm vào GLOBAL_TABLES kèm lý do:\n${laMat.join('\n')}`,
    ).toEqual([]);
  });

  it('tenant và identity có policy riêng (không lọt vòng lặp theo tenant_id)', async () => {
    const { rows } = await admin.query<{ bang: string; n: string }>(`
      SELECT c.relname AS bang, count(p.oid)::text AS n
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      LEFT JOIN pg_policy p ON p.polrelid = c.oid
      WHERE ns.nspname='public' AND c.relname IN ('tenant','identity')
      GROUP BY c.relname`);
    for (const r of rows) expect(Number(r.n), `${r.bang} không có policy`).toBeGreaterThan(0);
  });
});

// ============================================================================
describe('B. Đặc quyền: role của API không được bỏ qua RLS', () => {
  it('app_rw KHÔNG superuser và KHÔNG bypassrls', async () => {
    const { rows } = await admin.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_rw'`,
    );
    expect(rows[0], 'không tìm thấy role app_rw').toBeDefined();
    expect(rows[0]!.rolsuper, 'app_rw là SUPERUSER — RLS hoàn toàn vô hiệu').toBe(false);
    expect(rows[0]!.rolbypassrls, 'app_rw có BYPASSRLS — RLS hoàn toàn vô hiệu').toBe(false);
  });

  it('test này thật sự chạy bằng app_rw, không phải bằng superuser', async () => {
    // Chống chính test này trở thành vô nghĩa: nếu ai đó trỏ DATABASE_URL_APP
    // sang pt_migrator cho "tiện", mọi phép kiểm nhóm D sẽ xanh giả.
    const { rows } = await app.query<{ u: string; s: boolean; b: boolean }>(
      `SELECT current_user AS u,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS s,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS b`,
    );
    expect(rows[0]!.u).toBe('app_rw');
    expect(rows[0]!.s).toBe(false);
    expect(rows[0]!.b).toBe(false);
  });

  it('app_rw không đọc được bảng của mặt phẳng xác thực', async () => {
    for (const bang of ['otp_challenge', 'platform_audit_log']) {
      await expect(
        app.query(`SELECT 1 FROM ${bang} LIMIT 1`),
        `app_rw vẫn đọc được ${bang}`,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});

// ============================================================================
describe('C. Khoá: UNIQUE index phải mang tenant_id', () => {
  /**
   * Một UNIQUE index là an toàn khi nó chứa ít nhất một giá trị DUY NHẤT TOÀN
   * CỤC theo bản chất. Ba dạng:
   *   - cột uuid / bytea            -> UNIQUE(id), UNIQUE(booking_id)
   *   - cột do sequence sinh        -> khoá chính bigserial
   *   - có tenant_id trong index    -> cách ly tường minh
   * Chỉ khi KHÔNG có dạng nào mới là vi phạm — tức index toàn giá trị "dùng
   * lại được" (mã, tên, ngày, số thứ tự). Đó đúng là nơi sinh ra lỗi "phòng
   * thứ hai không đặt được mã PT10 vì phòng thứ nhất đã dùng".
   */
  const DETECT_SQL = `
    SELECT c.relname AS bang,
           i.relname AS idx,
           string_agg(a.attname, ',' ORDER BY a.attnum) AS cols
    FROM pg_index x
    JOIN pg_class c ON c.oid = x.indrelid
    JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (x.indkey)
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND x.indisunique
      AND EXISTS (SELECT 1 FROM pg_attribute t
                  WHERE t.attrelid = c.oid AND t.attname = 'tenant_id'
                    AND t.attnum > 0 AND NOT t.attisdropped)
    GROUP BY c.relname, i.relname
    HAVING NOT ('tenant_id' = ANY (array_agg(a.attname)))
       AND NOT bool_or(format_type(a.atttypid, NULL) IN ('uuid', 'bytea'))
       AND NOT bool_or(pg_get_serial_sequence(
                 quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname
               ) IS NOT NULL)
    ORDER BY 1, 2`;

  it('không có UNIQUE nào trên khoá nghiệp vụ mà thiếu tenant_id', async () => {
    const { rows } = await admin.query<{ bang: string; idx: string; cols: string }>(DETECT_SQL);
    const viPham = rows
      .filter((r) => !UNIQUE_INDEX_EXCEPTIONS.has(r.idx))
      .map((r) => `${r.bang}.${r.idx} (${r.cols})`);

    expect(
      viPham,
      `UNIQUE thiếu tenant_id. Phòng tập thứ hai sẽ không dùng được giá trị mà\n` +
        `phòng thứ nhất đã dùng, và thông báo lỗi ("đã tồn tại") vô nghĩa với họ\n` +
        `vì màn hình của họ trống:\n${viPham.join('\n')}`,
    ).toEqual([]);
  });

  it('bộ nhận diện KHÔNG rỗng: một UNIQUE sai thật sự bị bắt', async () => {
    // Test âm, chống tautology. Không có ca này thì một truy vấn luôn trả 0
    // dòng cũng làm ca trên xanh, và cổng gác trở thành trang trí.
    await admin.query('BEGIN');
    try {
      await admin.query(`
        CREATE TABLE _guard_probe (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id uuid NOT NULL,
          code text NOT NULL,
          CONSTRAINT _guard_probe_code_key UNIQUE (code)   -- CỐ Ý SAI
        )`);
      const { rows } = await admin.query<{ idx: string }>(DETECT_SQL);
      expect(rows.map((r) => r.idx)).toContain('_guard_probe_code_key');
    } finally {
      await admin.query('ROLLBACK');
    }
  });
});

// ============================================================================
describe('D. Hành vi: cách ly thật, bằng chính role của API', () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const { rows } = await admin.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM tenant ORDER BY created_at LIMIT 2`,
    );
    if (rows.length < 2) throw new Error('Cần ít nhất 2 tenant. Chạy: pnpm db:seed');
    tenantA = rows[0]!.id;
    tenantB = rows[1]!.id;
  });

  /** Chạy một câu lệnh trong transaction đã đặt app.tenant_id. */
  async function asTenant<T = unknown>(tenantId: string, sql: string): Promise<T[]> {
    await app.query('BEGIN');
    try {
      await app.query('SELECT set_config($1, $2, TRUE)', ['app.tenant_id', tenantId]);
      const r = await app.query(sql);
      await app.query('COMMIT');
      return r.rows as T[];
    } catch (e) {
      await app.query('ROLLBACK');
      throw e;
    }
  }

  it('không đặt app.tenant_id thì mọi bảng nghiệp vụ trả 0 dòng', async () => {
    for (const bang of ['member', 'trainer', 'member_package', 'booking', 'payment', 'invoice']) {
      const r = await app.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${bang}`);
      expect(Number(r.rows[0]!.n), `${bang} lộ dữ liệu khi chưa có ngữ cảnh tenant`).toBe(0);
    }
  });

  it('mỗi phòng chỉ thấy dữ liệu của mình, trên CÙNG một kết nối', async () => {
    const a = await asTenant<{ n: string }>(tenantA, `SELECT count(*)::text AS n FROM member`);
    const b = await asTenant<{ n: string }>(tenantB, `SELECT count(*)::text AS n FROM member`);
    const tong = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM member`);

    expect(Number(a[0]!.n)).toBeGreaterThan(0);
    expect(Number(b[0]!.n)).toBeGreaterThan(0);
    // Phép kiểm then chốt: không bên nào thấy tổng.
    expect(Number(a[0]!.n) + Number(b[0]!.n)).toBe(Number(tong.rows[0]!.n));
  });

  it('phòng A không thấy một dòng nào của phòng B', async () => {
    const r = await asTenant<{ n: string }>(
      tenantA,
      `SELECT count(*)::text AS n FROM member WHERE tenant_id <> '${tenantA}'`,
    );
    expect(Number(r[0]!.n)).toBe(0);
  });

  it('đang ở phòng A thì KHÔNG ghi được dữ liệu cho phòng B', async () => {
    await app.query('BEGIN');
    await app.query('SELECT set_config($1, $2, TRUE)', ['app.tenant_id', tenantA]);
    await expect(
      app.query(
        `INSERT INTO member (tenant_id, identity_id, code)
         SELECT $1, identity_id, 'XTEST' FROM member LIMIT 1`,
        [tenantB],
      ),
    ).rejects.toThrow(/row-level security/i);
    await app.query('ROLLBACK');
  });

  it('bảng tenant: mỗi phòng chỉ thấy chính mình', async () => {
    const r = await asTenant<{ id: string }>(tenantA, `SELECT id FROM tenant`);
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe(tenantA);
  });

  it('bảng identity: chỉ thấy người có vai trò tại phòng đang mở', async () => {
    const a = await asTenant<{ n: string }>(tenantA, `SELECT count(*)::text AS n FROM identity`);
    const tong = await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM identity`);
    expect(Number(a[0]!.n)).toBeGreaterThan(0);
    expect(
      Number(a[0]!.n),
      'app_rw đọc được định danh của phòng khác — số điện thoại khách hàng bị lộ',
    ).toBeLessThan(Number(tong.rows[0]!.n));
  });
});
