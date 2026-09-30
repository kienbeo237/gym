/**
 * Tách chủ-schema khỏi superuser trên một CSDL ĐANG CHẠY (máy thật đã dựng
 * trước khi 01-roles.sh biết tạo pt_migrator thường).
 *
 * Vì sao phải có: ảnh Docker Postgres dựng POSTGRES_USER=pt_migrator thành
 * SUPERUSER — và là "bootstrap superuser" (OID 10), thứ Postgres 16+ KHÔNG cho
 * hạ quyền, cũng không REASSIGN OWNED được (nó sở hữu cả catalog hệ thống). Một
 * lỗi ở bước migration / một SECURITY DEFINER viết hỏng đang chạy với quyền đọc
 * tệp máy chủ, COPY ... PROGRAM, ALTER SYSTEM.
 *
 * Cách làm — ba pha, mỗi pha tự nhận ra đã xong nên CHẠY LẠI ĐƯỢC khi đứt giữa chừng:
 *   A. (pt_migrator còn là superuser) tạo superuser tạm, dùng nó đổi tên
 *      pt_migrator -> postgres (superuser dự phòng, mật khẩu MỚI), tạo lại
 *      pt_migrator: LOGIN NOSUPERUSER BYPASSRLS, GIỮ mật khẩu cũ — nên
 *      DATABASE_URL của migrate trong .env không phải đổi.
 *   B. (đăng nhập postgres) chuyển chủ mọi bảng / view / matview / sequence /
 *      hàm / kiểu / schema của ứng dụng sang pt_migrator, cả CSDL; chép lại
 *      ALTER DEFAULT PRIVILEGES (0005 đặt theo OID role cũ — không chép thì bảng
 *      tạo ở migration sau KHÔNG tự cấp quyền cho app_rw); xoá superuser tạm.
 *   C. (đăng nhập pt_migrator) kiểm: không superuser, có BYPASSRLS, sở hữu đủ.
 *
 * BYPASSRLS là CỐ Ý: hàm SECURITY DEFINER (0007 tra danh tính, 0013 làm mới
 * báo cáo, 0015...) và view đối soát chạy bằng quyền chủ sở hữu, mà bảng đều
 * FORCE ROW LEVEL SECURITY. Chủ không BYPASSRLS thì các hàm đó nhận 0 dòng.
 * Thứ bỏ đi là SUPERUSER, không phải khả năng nhìn xuyên phòng của migrator.
 *
 * Chạy trên máy chủ (xem deploy/README.md, mục "Tách pt_migrator khỏi superuser"):
 *   docker compose -f docker-compose.prod.yml run --rm -e DB_SUPERUSER_PASSWORD \
 *     migrate ./node_modules/.bin/tsx db/demote-migrator.ts
 *
 * Bước B khoá ACCESS EXCLUSIVE từng bảng trong MỘT transaction (vài trăm ms với
 * schema này): request đang tới phải đợi chừng đó. lock_timeout 10s — không
 * chiếm được khoá thì huỷ sạch, chạy lại lúc vắng.
 */
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import 'dotenv/config';

const MIGRATOR = 'pt_migrator';
const SUPER = 'postgres';
const TAM = 'pt_demote_tmp';

const log = (s: string) => console.log(`[demote] ${s}`);

function urlVoi(goc: string, user: string, password: string, db?: string): string {
  const u = new URL(goc);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  if (db) u.pathname = `/${db}`;
  return u.toString();
}

async function voi<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function main() {
  const url = process.env.DATABASE_URL;
  const superPw = process.env.DB_SUPERUSER_PASSWORD;
  if (!url) throw new Error('Thiếu DATABASE_URL (pt_migrator)');
  if (!superPw || superPw.length < 24) throw new Error('Thiếu DB_SUPERUSER_PASSWORD (≥ 24 ký tự, sinh bằng: openssl rand -base64 32)');
  const u = new URL(url);
  if (decodeURIComponent(u.username) !== MIGRATOR) throw new Error(`DATABASE_URL phải đăng nhập bằng ${MIGRATOR}`);
  const migratorPw = decodeURIComponent(u.password);
  const dbName = u.pathname.replace(/^\//, '');

  // ---- trạng thái hiện tại (đăng nhập được bằng pt_migrator ở mọi pha) -------
  const st = await voi(url, async (c) => {
    const r = await c.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = ANY($1)`,
      [[MIGRATOR, SUPER, TAM]],
    );
    return Object.fromEntries(r.rows.map((x) => [x.rolname, x]));
  });

  // ---- A ----------------------------------------------------------------------
  if (st[MIGRATOR]?.rolsuper) {
    if (st[SUPER]) throw new Error(`Đã có role "${SUPER}" — dừng, xử lý tay (không đoán role nào là role nào)`);
    log(`A. ${MIGRATOR} đang là SUPERUSER -> đổi tên thành ${SUPER}, tạo ${MIGRATOR} thường`);
    const tamPw = randomBytes(24).toString('base64url');
    await voi(url, (c) =>
      c.query(
        st[TAM]
          ? `ALTER ROLE ${TAM} SUPERUSER LOGIN PASSWORD ${lit(tamPw)}`
          : `CREATE ROLE ${TAM} SUPERUSER LOGIN PASSWORD ${lit(tamPw)}`,
      ),
    );
    // Không đổi tên được role của CHÍNH phiên đang chạy -> làm từ phiên của role tạm.
    await voi(urlVoi(url, TAM, tamPw), async (c) => {
      await c.query('BEGIN');
      await c.query(`ALTER ROLE ${MIGRATOR} RENAME TO ${SUPER}`);
      await c.query(`ALTER ROLE ${SUPER} PASSWORD ${lit(superPw)}`);
      await c.query(
        `CREATE ROLE ${MIGRATOR} LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${lit(migratorPw)}`,
      );
      await c.query('COMMIT');
    });
  } else if (!st[SUPER]) {
    log(`${MIGRATOR} không phải superuser và không có role ${SUPER} — có vẻ dựng theo 01-roles.sh mới, không cần tách`);
  } else {
    log('A. đã xong từ lần trước');
  }

  // ---- B ----------------------------------------------------------------------
  const superUrl = urlVoi(url, SUPER, superPw);
  await voi(superUrl, async (c) => {
    const ton = await c.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [SUPER]);
    if (!ton.rowCount) return;
    log('B. chuyển chủ sở hữu');
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '10s'`);
    await c.query(`ALTER DATABASE ${c.escapeIdentifier(dbName)} OWNER TO ${MIGRATOR}`);
    const r = await c.query<{ cau: string }>(
      `
      WITH cu AS (SELECT oid FROM pg_roles WHERE rolname = $1),
      ns AS (
        SELECT oid, nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg\\_toast%' AND nspname NOT LIKE 'pg\\_temp%'
      ),
      -- Thành viên của extension (hàm của citext, pgcrypto...) để nguyên: chúng
      -- thuộc extension, đổi chủ lẻ từng cái là làm lệch với ALTER EXTENSION UPDATE.
      ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e')
      -- schema do ứng dụng tạo (public thuộc pg_database_owner từ PG15, đi theo chủ CSDL)
      SELECT format('ALTER SCHEMA %I OWNER TO ${MIGRATOR}', n.nspname) AS cau, 0 AS thu
        FROM pg_namespace n WHERE n.nspowner = (SELECT oid FROM cu) AND n.oid IN (SELECT oid FROM ns)
      UNION ALL
      -- bảng / view / matview / sequence ĐỘC LẬP (sequence của cột đi theo bảng)
      SELECT format('ALTER %s %I.%I OWNER TO ${MIGRATOR}',
                    CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
                                   WHEN 'S' THEN 'SEQUENCE' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
                    ns.nspname, c.relname), 1
        FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
       WHERE c.relowner = (SELECT oid FROM cu)
         AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
         AND (c.oid, 'pg_class'::regclass) NOT IN (SELECT objid, classid FROM ext)
         AND NOT (c.relkind = 'S' AND EXISTS (
               SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                  AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
      UNION ALL
      SELECT format('ALTER ROUTINE %s OWNER TO ${MIGRATOR}', p.oid::regprocedure), 2
        FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
       WHERE p.proowner = (SELECT oid FROM cu)
         AND (p.oid, 'pg_proc'::regclass) NOT IN (SELECT objid, classid FROM ext)
      UNION ALL
      -- enum / domain / range / composite đứng riêng; kiểu mảng và kiểu dòng của bảng đi theo gốc
      SELECT format('ALTER TYPE %s OWNER TO ${MIGRATOR}', t.oid::regtype), 3
        FROM pg_type t JOIN ns ON ns.oid = t.typnamespace
       WHERE t.typowner = (SELECT oid FROM cu)
         AND (t.typtype IN ('e', 'd', 'r')
              OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
         AND (t.oid, 'pg_type'::regclass) NOT IN (SELECT objid, classid FROM ext)
      ORDER BY 2
      `,
      [SUPER],
    );
    for (const { cau } of r.rows) await c.query(cau);
    log(`   ${r.rowCount} đối tượng đổi chủ`);

    // Quyền mặc định: chép từng dòng của role cũ sang pt_migrator.
    const md = await c.query<{ nsp: string | null; loai: string; grantee: string; quyen: string }>(
      `SELECT n.nspname AS nsp, d.defaclobjtype AS loai,
              CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(g.rolname) END AS grantee,
              string_agg(a.privilege_type, ', ' ORDER BY a.privilege_type) AS quyen
         FROM pg_default_acl d
         LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         LEFT JOIN pg_roles g ON g.oid = a.grantee
        WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = $1)
          AND a.grantee <> d.defaclrole
        GROUP BY 1, 2, 3`,
      [SUPER],
    );
    const TEN: Record<string, string> = { r: 'TABLES', S: 'SEQUENCES', f: 'FUNCTIONS', T: 'TYPES', n: 'SCHEMAS' };
    for (const x of md.rows) {
      await c.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR}${x.nsp ? ` IN SCHEMA ${c.escapeIdentifier(x.nsp)}` : ''} ` +
          `GRANT ${x.quyen} ON ${TEN[x.loai]} TO ${x.grantee}`,
      );
    }
    log(`   ${md.rowCount} dòng quyền mặc định chép sang ${MIGRATOR}`);
    await c.query('COMMIT');
    await c.query(`DROP ROLE IF EXISTS ${TAM}`);
  });

  // ---- C ----------------------------------------------------------------------
  await voi(url, async (c) => {
    const me = await c.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean }>(
      `SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = current_user`,
    );
    const con = await c.query<{ loai: string; ten: string }>(
      `SELECT 'bảng' AS loai, c.relname AS ten FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r','v','m') AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
       UNION ALL
       SELECT 'hàm', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`,
    );
    const m = me.rows[0]!;
    log(`C. ${MIGRATOR}: superuser=${m.rolsuper} bypassrls=${m.rolbypassrls} createrole=${m.rolcreaterole}`);
    if (m.rolsuper || !m.rolbypassrls || m.rolcreaterole) throw new Error('Thuộc tính pt_migrator sai');
    if (con.rowCount) throw new Error(`Còn ${con.rowCount} đối tượng chưa đổi chủ: ${con.rows.slice(0, 5).map((x) => `${x.loai} ${x.ten}`).join(', ')}`);
    log('Xong. Superuser dự phòng: role "postgres" (DB_SUPERUSER_PASSWORD) — chỉ dùng khi sửa tay.');
  });
}

main().catch((e: unknown) => {
  console.error(`[demote] LỖI: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
