/**
 * Dữ liệu cho kiểm thử tải: MỘT phòng riêng (slug `loadtest`), không đụng phòng khác.
 *
 *   pnpm loadtest:seed                      # 300 hội viên, 20 buổi đã tập mỗi người
 *   LT_MEMBERS=1000 LT_HISTORY=40 pnpm loadtest:seed
 *
 * Mỗi hội viên: một hợp đồng PT 60 buổi (sổ cái PURCHASE + CHECKIN khớp số đã
 * dùng), LT_HISTORY buổi COMPLETED trong quá khứ (có revenue_entry — để báo cáo
 * có số mà quét). Huấn luyện viên đủ để lịch quá khứ không chồng giờ (ràng buộc
 * EXCLUDE), mở khung 06:00–21:00 cả tuần.
 *
 * Tài khoản: chủ phòng +84970000000, hội viên +8497200xxxx, mật khẩu chung
 * `LT_PASSWORD` (mặc định Matkhau@123) — chỉ để đo ở máy dev / staging.
 *
 * Chạy bằng app_platform như db/seed.ts. TỪ CHỐI chạy khi NODE_ENV=production:
 * một phòng với hàng trăm tài khoản mật khẩu biết trước không được nằm trên máy thật.
 * Xoá: LT_RESET=1 pnpm loadtest:seed (xoá phòng loadtest rồi tạo lại).
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import 'dotenv/config';

const N = Number(process.env.LT_MEMBERS ?? 300);
const H = Number(process.env.LT_HISTORY ?? 20);
const PASSWORD = process.env.LT_PASSWORD ?? 'Matkhau@123';
const SLUG = 'loadtest';
/** Khung 06:00–21:00 = 15 giờ; mỗi HLV giữ tối đa 30 hội viên để lịch quá khứ vừa 2 ngày một vòng. */
const GIO = 15;
const HV_MOI_HLV = 30;
const PHIEN = 60;

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Không chạy seed kiểm thử tải ở production');
  if (N < 1 || N > 9999 || H < 0 || H > PHIEN) throw new Error('LT_MEMBERS 1..9999, LT_HISTORY 0..60');
  const url = process.env.DATABASE_URL_PLATFORM;
  if (!url) throw new Error('Thiếu DATABASE_URL_PLATFORM (xem .env.example)');
  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    const cu = await db.query<{ id: string }>(`SELECT id FROM tenant WHERE slug = $1`, [SLUG]);
    if (cu.rows[0]) {
      if (process.env.LT_RESET !== '1') {
        console.log(`Đã có phòng ${SLUG} (${cu.rows[0].id}) — bỏ qua. Tạo lại: LT_RESET=1 pnpm loadtest:seed`);
        return;
      }
      await xoaPhong(db, cu.rows[0].id);
    }

    const t0 = Date.now();
    const hash = await bcrypt.hash(PASSWORD, 10);
    const T = Math.max(1, Math.ceil(N / HV_MOI_HLV));
    const tenantId = randomUUID();
    await db.query('BEGIN');

    await db.query(`INSERT INTO tenant (id, slug, name, status) VALUES ($1,$2,'Load Test Gym','ACTIVE')`, [tenantId, SLUG]);
    await db.query(`INSERT INTO tenant_policy (tenant_id) VALUES ($1)`, [tenantId]);
    await db.query(
      `INSERT INTO tenant_subscription (tenant_id, plan_code, status, current_period_start, current_period_end)
       VALUES ($1,'PRO','ACTIVE', date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month - 1 day')::date)`,
      [tenantId],
    );

    // --- danh tính: chủ phòng, HLV, hội viên (một câu lệnh mỗi loại) ---
    const themNguoi = async (phones: string[], names: string[], role: string) => {
      const ids = phones.map(() => randomUUID());
      await db.query(
        `INSERT INTO identity (id, phone, full_name, password_hash, phone_verified_at)
         SELECT id, phone, name, $4, now() FROM unnest($1::uuid[], $2::text[], $3::text[]) AS x(id, phone, name)`,
        [ids, phones, names, hash],
      );
      await db.query(
        `INSERT INTO tenant_user (tenant_id, identity_id, role) SELECT $1, unnest($2::uuid[]), $3`,
        [tenantId, ids, role],
      );
      return ids;
    };
    const so = (dau: string, i: number) => `+84${dau}${String(i).padStart(5, '0')}`;
    await themNguoi(['+84970000000'], ['Chủ phòng Load Test'], 'OWNER');

    const tIdn = await themNguoi(
      Array.from({ length: T }, (_, i) => so('9710', i)),
      Array.from({ length: T }, (_, i) => `HLV tải ${i + 1}`),
      'PT',
    );
    const trainerIds = tIdn.map(() => randomUUID());
    await db.query(
      `INSERT INTO trainer (id, tenant_id, identity_id, code, level, base_salary, hired_on)
       SELECT id, $1, idn, 'LT' || lpad(n::text, 3, '0'), 'JUNIOR', 6000000, current_date - 400
         FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS x(id, idn, n)`,
      [tenantId, trainerIds, tIdn],
    );
    await db.query(
      `INSERT INTO trainer_availability (tenant_id, trainer_id, weekday, start_time, end_time)
       SELECT $1, t, d, '06:00', '21:00' FROM unnest($2::uuid[]) t CROSS JOIN generate_series(0, 6) d`,
      [tenantId, trainerIds],
    );

    const mIdn = await themNguoi(
      Array.from({ length: N }, (_, i) => so('9720', i)),
      Array.from({ length: N }, (_, i) => `Hội viên tải ${i + 1}`),
      'MEMBER',
    );
    const memberIds = mIdn.map(() => randomUUID());
    await db.query(
      `INSERT INTO member (id, tenant_id, identity_id, code, gender, source)
       SELECT id, $1, idn, 'LT' || lpad(n::text, 5, '0'), CASE WHEN n % 2 = 0 THEN 'FEMALE' ELSE 'MALE' END, 'WALK_IN'
         FROM unnest($2::uuid[], $3::uuid[]) WITH ORDINALITY AS x(id, idn, n)`,
      [tenantId, memberIds, mIdn],
    );

    // --- một hợp đồng / người ---
    const tpl = randomUUID();
    const gia = 30_000_000;
    await db.query(
      `INSERT INTO package_template (id, tenant_id, code, name, kind, sessions, valid_days, price)
       VALUES ($1,$2,'PT60','Gói PT 60 buổi','PT',$3,365,$4)`,
      [tpl, tenantId, PHIEN, gia],
    );
    const mpIds = memberIds.map(() => randomUUID());
    const hlvCua = memberIds.map((_, i) => trainerIds[i % T]!);
    await db.query(
      `INSERT INTO member_package (id, tenant_id, member_id, template_id, code, name_snapshot, price_gross, discount,
                                   sessions_total, sessions_used, sold_by_id, trainer_id, starts_on, expires_on)
       SELECT id, $1, m, $2, 'LT-HD' || lpad(n::text, 5, '0'), 'Gói PT 60 buổi', $3, 0, $4, $5, t, t,
              current_date - 150, current_date + 215
         FROM unnest($6::uuid[], $7::uuid[], $8::uuid[]) WITH ORDINALITY AS x(id, m, t, n)`,
      [tenantId, tpl, gia, PHIEN, H, mpIds, memberIds, hlvCua],
    );
    await db.query(
      `INSERT INTO session_ledger (tenant_id, member_package_id, delta, reason, ref_type, ref_id)
       SELECT $1, mp, $2, 'PURCHASE', 'MEMBER_PACKAGE', mp FROM unnest($3::uuid[]) mp`,
      [tenantId, PHIEN, mpIds],
    );

    // --- lịch sử: H buổi đã tập / người, không chồng giờ HLV lẫn hội viên ---
    // Hội viên thứ j của một HLV: giờ 6 + j % 15, lệch ngày j / 15; mỗi vòng cách `buoc` ngày.
    const buoc = Math.ceil(HV_MOI_HLV / GIO);
    const bk: string[] = [], bMp: string[] = [], bM: string[] = [], bT: string[] = [], bNgay: number[] = [], bGio: number[] = [];
    for (let i = 0; i < N; i++) {
      const j = Math.floor(i / T);
      for (let k = 0; k < H; k++) {
        bk.push(randomUUID());
        bMp.push(mpIds[i]!);
        bM.push(memberIds[i]!);
        bT.push(hlvCua[i]!);
        bNgay.push(1 + k * buoc + Math.floor(j / GIO));
        bGio.push(6 + (j % GIO));
      }
    }
    for (let o = 0; o < bk.length; o += 5000) {
      const p = (a: unknown[]) => a.slice(o, o + 5000);
      await db.query(
        `WITH x AS (
           SELECT id, mp, m, t, ((current_date - d) + make_time(h, 0, 0)) AT TIME ZONE 'Asia/Ho_Chi_Minh' AS s
             FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::uuid[], $6::int[], $7::int[]) AS u(id, mp, m, t, d, h)
         ), b AS (
           INSERT INTO booking (id, tenant_id, member_package_id, member_id, trainer_id, starts_at, ends_at,
                                status, checkin_at, checkin_method, deducted)
           SELECT id, $1, mp, m, t, s, s + interval '1 hour', 'COMPLETED', s, 'QR', true FROM x
           RETURNING id, member_package_id, trainer_id
         ), l AS (
           INSERT INTO session_ledger (tenant_id, member_package_id, delta, reason, ref_type, ref_id)
           SELECT $1, member_package_id, -1, 'CHECKIN', 'BOOKING', id FROM b
         ), c AS (
           -- Mỗi buổi CHECKIN có đúng một dòng hoa hồng TEACH, như checkin thật —
           -- thiếu là v_teach_commission_drift báo lệch và worker kêu "ĐỐI SOÁT LỆCH".
           -- Chính sách giả định 0 đồng (không 'missing', để v_commission_needs_policy im).
           INSERT INTO commission_entry (tenant_id, trainer_id, kind, member_package_id, booking_id,
                                         base_amount, amount, policy_snapshot, earned_at, period_month)
           SELECT $1, x.t, 'TEACH', x.mp, x.id, $8, 0,
                  jsonb_build_object('teachMode', 'FIXED', 'teachFixedAmount', 0, 'loadtest', true,
                                     'resolvedOn', (x.s AT TIME ZONE 'Asia/Ho_Chi_Minh')::date),
                  x.s, date_trunc('month', x.s AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
             FROM x JOIN b ON b.id = x.id
         )
         INSERT INTO revenue_entry (tenant_id, member_package_id, booking_id, trainer_id, amount)
         SELECT $1, member_package_id, id, trainer_id, $8 FROM b`,
        [tenantId, p(bk), p(bMp), p(bM), p(bT), p(bNgay), p(bGio), Math.round(gia / PHIEN)],
      );
    }

    await db.query('COMMIT');
    console.log(`Phòng ${SLUG} ${tenantId}: ${T} HLV, ${N} hội viên, ${bk.length} buổi lịch sử — ${Date.now() - t0} ms`);
    console.log(`Chủ phòng +84970000000, hội viên ${so('9720', 0)}..${so('9720', N - 1)} / ${PASSWORD}`);
    console.log('Chạy tải: pnpm loadtest   (xem scripts/loadtest/run.mjs)');
  } catch (e) {
    await db.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await db.end();
  }
}

/**
 * Xoá phòng loadtest. Sổ cái / doanh thu chỉ-ghi-thêm có trigger chặn DELETE,
 * nên tắt trigger người dùng trong phiên này (session_replication_role) — cần
 * quyền cao hơn app_platform: chạy bằng DATABASE_URL (chủ schema) nếu có.
 */
async function xoaPhong(_db: Client, tenantId: string) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Xoá phòng loadtest cần DATABASE_URL (chủ schema)');
  const su = new Client({ connectionString: url });
  await su.connect();
  try {
    await su.query('BEGIN');
    await su.query(`SET LOCAL session_replication_role = replica`);
    // replica tắt cả trigger FK -> ON DELETE CASCADE KHÔNG chạy: xoá tay MỌI bảng
    // có tenant_id (đọc từ catalog, để bảng thêm về sau cũng được xoá).
    const bang = await su.query<{ t: string }>(
      `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`,
    );
    const idn = await su.query<{ identity_id: string }>(`SELECT identity_id FROM tenant_user WHERE tenant_id = $1`, [tenantId]);
    for (const { t } of bang.rows) await su.query(`DELETE FROM ${su.escapeIdentifier(t)} WHERE tenant_id = $1`, [tenantId]);
    await su.query(`DELETE FROM tenant WHERE id = $1`, [tenantId]);
    // Danh tính chỉ thuộc phòng này thì xoá luôn — số điện thoại +8497… là của seed.
    // Kèm các dòng toàn cục trỏ tới chúng (cascade cũng không chạy ở đây).
    const xoa = (
      await su.query<{ id: string }>(
        `SELECT i.id FROM identity i WHERE i.id = ANY($1::uuid[]) AND i.phone LIKE '+8497%'
            AND NOT EXISTS (SELECT 1 FROM tenant_user tu WHERE tu.identity_id = i.id)`,
        [idn.rows.map((r) => r.identity_id)],
      )
    ).rows.map((r) => r.id);
    await su.query(`DELETE FROM refresh_token WHERE identity_id = ANY($1::uuid[])`, [xoa]);
    await su.query(`DELETE FROM identity_phone_history WHERE identity_id = ANY($1::uuid[])`, [xoa]);
    await su.query(`DELETE FROM identity WHERE id = ANY($1::uuid[])`, [xoa]);
    await su.query('COMMIT');
    console.log(`Đã xoá phòng ${SLUG} cũ (${tenantId})`);
  } catch (e) {
    await su.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    await su.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
