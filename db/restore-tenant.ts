/**
 * Khôi phục dữ liệu của MỘT phòng tập từ bản sao lưu, không đụng phòng khác.
 *
 * Schema dùng chung nên pg_restore là tất-cả-hoặc-không. Cách làm:
 *   1. pg_restore bản sao lưu vào một CSDL TẠM (cùng cụm) — xem deploy/README.md.
 *   2. Script này chép dữ liệu của phòng đó từ CSDL tạm về CSDL thật.
 *
 *   RESTORE_FROM_URL=postgres://postgres:…@postgres:5432/pt_restore \
 *   RESTORE_TO_URL=postgres://postgres:…@postgres:5432/pt \
 *   tsx db/restore-tenant.ts --tenant <uuid>            # chạy thử: chỉ in số dòng
 *   tsx db/restore-tenant.ts --tenant <uuid> --apply    # làm thật, một transaction
 *
 * Đăng nhập SUPERUSER ở cả hai đầu (role `postgres`, xem db/demote-migrator.ts):
 * chép bằng session_replication_role = replica, tức TẮT trigger — kể cả trigger
 * chặn sửa/xoá của sổ cái chỉ-ghi-thêm và trigger cập nhật số dư. Đó là điều
 * đúng: bản sao lưu đã chứa TRẠNG THÁI CUỐI (member_package.sessions_used khớp
 * sổ cái), chạy lại trigger khi chép là cộng hai lần. Đổi lại, FK cũng là
 * trigger nên cũng tắt — script tự kiểm MỌI khoá ngoại dính tới phòng này trước
 * khi COMMIT, và chạy tám view đối soát; lệch là ROLLBACK.
 *
 * Mỗi bảng có tenant_id thuộc đúng MỘT nhóm dưới đây. Bảng mới chưa xếp nhóm thì
 * script DỪNG — người thêm bảng phải quyết định, không đoán thay.
 */
import { Client } from 'pg';
import 'dotenv/config';

/** Dữ liệu nghiệp vụ: xoá bản hiện tại của phòng, chép nguyên từ bản sao lưu. */
const RESTORE = [
  'tenant_user', 'tenant_policy', 'member', 'trainer', 'trainer_availability', 'package_template',
  'member_package', 'package_freeze', 'session_ledger', 'booking', 'revenue_entry', 'commission_policy',
  'commission_entry', 'file_object', 'campaign', 'campaign_enrollment', 'invoice', 'invoice_item',
  'payment_schedule', 'payment', 'payroll_run', 'payroll_line', 'member_progress',
];
/**
 * Xoá, KHÔNG chép lại: phiên đăng nhập (khôi phục = hồi sinh token cũ; mọi người
 * của phòng đăng nhập lại) và mã QR điểm danh (sống vài chục giây).
 */
const CLEAR = ['refresh_token', 'checkin_token'];
/**
 * Giữ bản hiện tại. Quan hệ giữa phòng với NỀN TẢNG (gói SaaS, tiền phòng đã trả
 * cho mình sau ngày sao lưu), tích hợp Zalo (refresh token Zalo xoay vòng — bản
 * cũ đã chết), lịch sử tin đã gửi và bộ đếm tin (tiền thật). Dòng nào trỏ tới
 * dữ liệu nghiệp vụ không còn (hội viên tạo sau ngày sao lưu) thì bị xoá.
 */
const KEEP = [
  'tenant_subscription', 'tenant_billing_record', 'plan_change_request', 'tenant_zalo_oa',
  'tenant_zns_template', 'notification_outbox', 'tenant_message_usage',
];
/** Nhật ký: giữ bản hiện tại VÀ bù những dòng chỉ có trong bản sao lưu. */
const APPEND = ['audit_log'];

const DRIFT_VIEWS = [
  'v_session_balance_drift', 'v_invoice_paid_drift', 'v_sale_commission_drift', 'v_commission_needs_policy',
  'v_revenue_drift', 'v_teach_commission_drift', 'v_revenue_over_contract', 'v_payroll_drift',
];
const LO = 2000;

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const co = (k: string) => process.argv.includes(k);
const log = (s: string) => console.log(`[restore] ${s}`);

type Fk = { ten: string; con: string; cha: string; cotCon: string[]; cotCha: string[] };

async function main() {
  const tenantId = arg('--tenant');
  const apply = co('--apply');
  const from = process.env.RESTORE_FROM_URL;
  const to = process.env.RESTORE_TO_URL;
  if (!tenantId || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('Thiếu --tenant <uuid>');
  if (!from || !to) throw new Error('Thiếu RESTORE_FROM_URL (CSDL tạm) / RESTORE_TO_URL (CSDL thật)');
  if (from === to) throw new Error('RESTORE_FROM_URL trùng RESTORE_TO_URL');

  const src = new Client({ connectionString: from });
  const dst = new Client({ connectionString: to });
  await src.connect();
  await dst.connect();
  try {
    // ---- điều kiện -------------------------------------------------------------
    for (const [ten, c] of [['nguồn', src], ['đích', dst]] as const) {
      const r = await c.query<{ rolsuper: boolean }>(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
      if (!r.rows[0]?.rolsuper) throw new Error(`Kết nối ${ten} phải là superuser (cần session_replication_role)`);
    }
    const ver = async (c: Client) =>
      (await c.query<{ v: string }>(`SELECT max(version) AS v FROM schema_migrations`)).rows[0]!.v;
    const [vs, vd] = [await ver(src), await ver(dst)];
    if (vs !== vd) {
      throw new Error(
        `Schema lệch: bản sao lưu ở migration ${vs}, CSDL thật ở ${vd}. ` +
          `Chạy migration lên CSDL tạm trước: DATABASE_URL=<RESTORE_FROM_URL> tsx db/migrate.ts up`,
      );
    }
    const tSrc = await src.query<{ name: string }>(`SELECT name FROM tenant WHERE id = $1`, [tenantId]);
    if (!tSrc.rowCount) throw new Error(`Bản sao lưu không có phòng ${tenantId}`);
    const tDst = await dst.query<{ name: string }>(`SELECT name FROM tenant WHERE id = $1`, [tenantId]);
    const taoLaiPhong = !tDst.rowCount;
    log(`Phòng "${tSrc.rows[0]!.name}" (${tenantId}) — ${taoLaiPhong ? 'KHÔNG còn ở CSDL thật: tạo lại cả phòng' : 'đang có ở CSDL thật'}`);

    // ---- xếp nhóm bảng ---------------------------------------------------------
    const bang = (
      await dst.query<{ t: string }>(
        `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    const nhom = new Set([...RESTORE, ...CLEAR, ...KEEP, ...APPEND]);
    const chuaXep = bang.filter((t) => !nhom.has(t));
    if (chuaXep.length) throw new Error(`Bảng có tenant_id chưa xếp nhóm trong restore-tenant.ts: ${chuaXep.join(', ')}`);
    const thua = [...nhom].filter((t) => !bang.includes(t));
    if (thua.length) log(`(bỏ qua, không có ở schema này: ${thua.join(', ')})`);

    // Tạo lại cả phòng thì bảng "giữ" cũng phải lấy từ bản sao lưu — đích không có gì để giữ.
    const chep = [...RESTORE, ...(taoLaiPhong ? KEEP : [])].filter((t) => bang.includes(t));
    const xoa = [...RESTORE, ...CLEAR].filter((t) => bang.includes(t));
    const bu = APPEND.filter((t) => bang.includes(t));
    const giu = taoLaiPhong ? [] : KEEP.filter((t) => bang.includes(t));

    // ---- chạy thử: số dòng -------------------------------------------------------
    const dem = async (c: Client, t: string) =>
      Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t} WHERE tenant_id = $1`, [tenantId])).rows[0]!.n);
    const hang: Record<string, unknown>[] = [];
    for (const t of bang) {
      const viec = chep.includes(t) ? 'khôi phục' : CLEAR.includes(t) ? 'xoá' : bu.includes(t) ? 'bù thêm' : 'giữ';
      hang.push({ 'bảng': t, 'việc': viec, 'hiện tại': await dem(dst, t).catch(() => 0), 'bản sao lưu': await dem(src, t) });
    }
    console.table(hang);
    if (!apply) {
      log('Chạy thử xong — chưa ghi gì. Thêm --apply để khôi phục.');
      return;
    }

    // ---- khoá ngoại (đọc từ catalog đích) ----------------------------------------
    const fks = (
      await dst.query<Fk>(
        `SELECT con.conname AS ten, cc.relname AS con, pc.relname AS cha,
                array(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS "cotCon",
                array(SELECT a.attname FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS "cotCha"
           FROM pg_constraint con
           JOIN pg_class cc ON cc.oid = con.conrelid JOIN pg_class pc ON pc.oid = con.confrelid
           JOIN pg_namespace n ON n.oid = cc.relnamespace
          WHERE con.contype = 'f' AND n.nspname = 'public'`,
      )
    ).rows;

    await dst.query('BEGIN');
    await dst.query(`SET LOCAL session_replication_role = replica`);
    await dst.query(`SET LOCAL lock_timeout = '10s'`);

    // 1. Danh tính (bảng toàn cục) mà dữ liệu khôi phục trỏ tới nhưng đích không còn.
    const canId = new Set<string>();
    for (const fk of fks.filter((f) => f.cha === 'identity' && [...chep, ...bu].includes(f.con) && f.cotCon.length === 1)) {
      const r = await src.query<{ v: string }>(
        `SELECT DISTINCT ${fk.cotCon[0]} AS v FROM ${fk.con} WHERE tenant_id = $1 AND ${fk.cotCon[0]} IS NOT NULL`,
        [tenantId],
      );
      r.rows.forEach((x) => canId.add(x.v));
    }
    if (canId.size) {
      const daCo = await dst.query<{ id: string }>(`SELECT id FROM identity WHERE id = ANY($1::uuid[])`, [[...canId]]);
      const thieu = [...canId].filter((id) => !daCo.rows.some((r) => r.id === id));
      if (thieu.length) {
        const rows = await src.query<{ j: string }>(
          `SELECT json_agg(i)::text AS j FROM identity i WHERE id = ANY($1::uuid[])`,
          [thieu],
        );
        const trung = await dst.query<{ phone: string }>(
          `SELECT phone FROM identity WHERE phone IN (SELECT phone FROM json_populate_recordset(null::identity, $1::json))`,
          [rows.rows[0]!.j],
        );
        if (trung.rowCount) {
          throw new Error(`Số điện thoại đã thuộc người khác ở CSDL thật: ${trung.rows.map((r) => r.phone).join(', ')} — xử lý tay`);
        }
        await chenJson(dst, 'identity', rows.rows[0]!.j, false);
        log(`danh tính: bù ${thieu.length} người không còn ở CSDL thật`);
      }
    }

    // 2. Xoá bản hiện tại (trigger tắt: sổ cái chỉ-ghi-thêm xoá được, cascade KHÔNG chạy).
    if (taoLaiPhong) await chepBang(src, dst, 'tenant', `id = $1`, tenantId);
    // Chuỗi xoay vòng refresh token có thể đi từ token chưa chọn phòng (tenant_id NULL,
    // không bị xoá) sang token của phòng này — cắt mắt xích trước khi xoá.
    if (xoa.includes('refresh_token')) {
      await dst.query(
        `UPDATE refresh_token SET replaced_by = NULL
          WHERE replaced_by IN (SELECT id FROM refresh_token WHERE tenant_id = $1)`,
        [tenantId],
      );
    }
    for (const t of xoa) await dst.query(`DELETE FROM ${t} WHERE tenant_id = $1`, [tenantId]);

    // 3. Chép.
    for (const t of chep) {
      const n = await chepBang(src, dst, t, `tenant_id = $1`, tenantId);
      if (n) log(`${t}: ${n}`);
    }
    for (const t of bu) {
      const n = await chepBang(src, dst, t, `tenant_id = $1`, tenantId, true);
      log(`${t}: bù ${n} dòng chỉ có trong bản sao lưu`);
    }

    // 4. Bảng giữ nguyên: dòng trỏ tới dữ liệu nghiệp vụ không còn -> xoá.
    for (const fk of fks.filter((f) => giu.includes(f.con) && chep.includes(f.cha))) {
      const r = await dst.query(
        `DELETE FROM ${fk.con} c WHERE c.tenant_id = $1 AND ${fk.cotCon.map((x) => `c.${x} IS NOT NULL`).join(' AND ')}
            AND NOT EXISTS (SELECT 1 FROM ${fk.cha} p WHERE ${fk.cotCha.map((x, i) => `p.${x} = c.${fk.cotCon[i]}`).join(' AND ')})`,
        [tenantId],
      );
      if (r.rowCount) log(`${fk.con}: xoá ${r.rowCount} dòng trỏ tới ${fk.cha} không còn (${fk.ten})`);
    }

    // 5. Kiểm MỌI khoá ngoại dính tới dữ liệu vừa chép (FK là trigger, vừa bị tắt).
    const dinh = new Set([...chep, ...xoa, ...bu, 'tenant']);
    let vo = 0;
    for (const fk of fks.filter((f) => dinh.has(f.con) || dinh.has(f.cha))) {
      const coTenant = bang.includes(fk.con);
      const r = await dst.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${fk.con} c
          WHERE ${coTenant ? 'c.tenant_id = $1 AND ' : '$1::uuid IS NOT NULL AND '}${fk.cotCon.map((x) => `c.${x} IS NOT NULL`).join(' AND ')}
            AND NOT EXISTS (SELECT 1 FROM ${fk.cha} p WHERE ${fk.cotCha.map((x, i) => `p.${x} = c.${fk.cotCon[i]}`).join(' AND ')})`,
        [tenantId],
      );
      const n = Number(r.rows[0]!.n);
      if (n) {
        vo += n;
        log(`VỠ khoá ngoại ${fk.ten}: ${n} dòng ${fk.con} -> ${fk.cha}`);
      }
    }
    if (vo) throw new Error(`${vo} dòng vỡ khoá ngoại — huỷ, không ghi gì`);

    // 6. Đối soát: bản sao lưu nhất quán thì tám view đều rỗng cho phòng này.
    let lech = 0;
    for (const v of DRIFT_VIEWS) {
      const r = await dst.query<{ n: string }>(`SELECT count(*) AS n FROM ${v} WHERE tenant_id = $1`, [tenantId]).catch(() => null);
      const n = Number(r?.rows[0]?.n ?? 0);
      if (n) {
        lech += n;
        log(`đối soát ${v}: ${n} dòng lệch`);
      }
    }
    if (lech && !co('--allow-drift')) throw new Error(`${lech} dòng lệch đối soát — huỷ. Chắc chắn bản sao lưu vốn lệch vậy thì thêm --allow-drift`);

    // 7. Sequence: id từ quá khứ nên luôn nhỏ hơn giá trị hiện tại — vẫn nâng cho chắc.
    await dst.query(`SET LOCAL session_replication_role = origin`);
    for (const t of [...chep, ...bu]) {
      const s = await dst.query<{ seq: string; col: string }>(
        `SELECT pg_get_serial_sequence($1, a.attname) AS seq, a.attname AS col FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
            AND pg_get_serial_sequence($1, a.attname) IS NOT NULL`,
        [t],
      );
      for (const x of s.rows) {
        await dst.query(`SELECT setval($1, GREATEST((SELECT last_value FROM ${x.seq}), (SELECT COALESCE(max(${x.col}), 1) FROM ${t})))`, [x.seq]);
      }
    }
    await dst.query(
      `INSERT INTO platform_audit_log (target_tenant, action, detail) VALUES ($1, 'TENANT_RESTORE', $2)`,
      [tenantId, JSON.stringify({ tu: new URL(from).pathname, bang: chep, xoa: CLEAR, taoLaiPhong, lechDoiSoat: lech })],
    );
    await dst.query('COMMIT');
    log('Đã COMMIT.');

    // 8. Báo cáo tổng hợp đọc từ matview — làm mới sau khi dữ liệu đổi.
    const mv = await dst.query<{ t: string }>(
      `SELECT matviewname AS t FROM pg_matviews WHERE schemaname = 'public' ORDER BY 1`,
    );
    for (const { t } of mv.rows) await dst.query(`REFRESH MATERIALIZED VIEW ${t}`);
    log(`làm mới ${mv.rowCount} matview. Xong — mọi người của phòng phải đăng nhập lại.`);
  } catch (e) {
    await dst.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await src.end();
    await dst.end();
  }
}

/** Cột ghi được: bỏ cột GENERATED (Postgres tự tính lại). */
async function cotGhi(c: Client, t: string): Promise<string[]> {
  const r = await c.query<{ a: string }>(
    `SELECT quote_ident(attname) AS a FROM pg_attribute
      WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' ORDER BY attnum`,
    [t],
  );
  return r.rows.map((x) => x.a);
}

/**
 * Chuyển dòng dưới dạng JSON văn bản (row_to_json -> json_populate_recordset):
 * timestamptz giữ đủ micro giây, numeric giữ nguyên chữ số, bytea đi dạng \x…,
 * jsonb lồng nhau giữ nguyên — không qua kiểu JS nào.
 */
async function chenJson(dst: Client, t: string, json: string, boQuaTrung: boolean): Promise<number> {
  const cot = (await cotGhi(dst, t)).join(', ');
  const r = await dst.query(
    `INSERT INTO ${t} (${cot}) OVERRIDING SYSTEM VALUE
     SELECT ${cot} FROM json_populate_recordset(null::${t}, $1::json)
     ${boQuaTrung ? 'ON CONFLICT DO NOTHING' : ''}`,
    [json],
  );
  return r.rowCount ?? 0;
}

async function chepBang(src: Client, dst: Client, t: string, where: string, tenantId: string, boQuaTrung = false) {
  let n = 0;
  for (let o = 0; ; o += LO) {
    const r = await src.query<{ j: string | null }>(
      `SELECT json_agg(x)::text AS j FROM (SELECT * FROM ${t} WHERE ${where} ORDER BY ctid LIMIT ${LO} OFFSET ${o}) x`,
      [tenantId],
    );
    const j = r.rows[0]!.j;
    if (!j) break;
    n += await chenJson(dst, t, j, boQuaTrung);
  }
  return n;
}

main().catch((e: unknown) => {
  console.error(`[restore] LỖI: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
