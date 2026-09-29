/**
 * Dữ liệu mẫu cho dev.
 *
 * Chạy bằng role app_platform (BYPASSRLS) — con đường hợp lệ duy nhất để ghi
 * dữ liệu của nhiều tenant trong một tiến trình.
 *
 * Lưu ý về pt_migrator: ảnh postgres đặt POSTGRES_USER làm SUPERUSER, mà
 * superuser bỏ qua RLS kể cả khi bảng đã FORCE. Nên chạy seed bằng pt_migrator
 * cũng "được" — và đó chính là lý do KHÔNG dùng nó: nó che mất việc quyền nào
 * thực sự cần thiết. Môi trường thật phải tách chủ-sở-hữu-schema khỏi superuser.
 *
 * Tạo HAI phòng tập, cố ý: mọi kiểm tra cách ly đều cần ít nhất hai tenant.
 */
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import 'dotenv/config';

const PASSWORD = 'Matkhau@123';

type Ctx = { db: Client; hash: string };

async function makeTenant(
  ctx: Ctx,
  slug: string,
  name: string,
  seq: number,
): Promise<{ tenantId: string; trainerIds: string[]; memberIds: string[] }> {
  const { db, hash } = ctx;
  const tenantId = randomUUID();

  await db.query(
    `INSERT INTO tenant (id, slug, name, status) VALUES ($1,$2,$3,'ACTIVE')`,
    [tenantId, slug, name],
  );
  await db.query(`INSERT INTO tenant_policy (tenant_id) VALUES ($1)`, [tenantId]);
  await db.query(
    `INSERT INTO tenant_subscription (tenant_id, plan_code, status, current_period_start, current_period_end)
     VALUES ($1,'PRO','ACTIVE', date_trunc('month', now())::date,
             (date_trunc('month', now()) + interval '1 month - 1 day')::date)`,
    [tenantId],
  );

  const addIdentity = async (phone: string, fullName: string, email?: string) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO identity (id, phone, email, full_name, password_hash, phone_verified_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [id, phone, email ?? null, fullName, hash],
    );
    return id;
  };
  const link = (identityId: string, role: string) =>
    db.query(`INSERT INTO tenant_user (tenant_id, identity_id, role) VALUES ($1,$2,$3)`, [
      tenantId,
      identityId,
      role,
    ]);

  // --- chủ phòng ---
  const ownerId = await addIdentity(`+8490${seq}000001`, `Chủ phòng ${name}`, `owner${seq}@pt.local`);
  await link(ownerId, 'OWNER');

  // --- huấn luyện viên ---
  const trainerNames = ['Nguyễn Văn Hùng', 'Trần Thị Mai'];
  const trainerIds: string[] = [];
  for (let i = 0; i < trainerNames.length; i++) {
    const idn = await addIdentity(`+8490${seq}10000${i + 1}`, trainerNames[i]!);
    await link(idn, 'PT');
    const trainerId = randomUUID();
    await db.query(
      `INSERT INTO trainer (id, tenant_id, identity_id, code, level, base_salary, hired_on)
       VALUES ($1,$2,$3,$4,$5,$6, current_date - 200)`,
      [trainerId, tenantId, idn, `PT${i + 1}`, i === 0 ? 'SENIOR' : 'JUNIOR', 6_000_000],
    );
    trainerIds.push(trainerId);
  }

  // --- hội viên ---
  const memberNames = ['Lê Minh Anh', 'Phạm Quốc Bảo', 'Vũ Thu Hà', 'Đỗ Hoàng Nam', 'Bùi Khánh Linh'];
  const memberIds: string[] = [];
  for (let i = 0; i < memberNames.length; i++) {
    const idn = await addIdentity(`+8490${seq}20000${i + 1}`, memberNames[i]!);
    await link(idn, 'MEMBER');
    const memberId = randomUUID();
    await db.query(
      `INSERT INTO member (id, tenant_id, identity_id, code, gender, source)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [memberId, tenantId, idn, `HV${String(i + 1).padStart(4, '0')}`,
       i % 2 === 0 ? 'FEMALE' : 'MALE', i < 2 ? 'WALK_IN' : 'ZALO'],
    );
    memberIds.push(memberId);
  }

  // --- gói bán ---
  const templates = [
    { code: 'PT10', name: 'Gói PT 10 buổi', kind: 'PT', sessions: 10, days: 90, price: 6_000_000 },
    { code: 'PT30', name: 'Gói PT 30 buổi', kind: 'PT', sessions: 30, days: 180, price: 15_000_000 },
    { code: 'GYM12', name: 'Thẻ tập 12 tháng', kind: 'GYM', sessions: 365, days: 365, price: 4_800_000 },
  ];
  const templateIds: Record<string, string> = {};
  for (const t of templates) {
    const id = randomUUID();
    templateIds[t.code] = id;
    await db.query(
      `INSERT INTO package_template (id, tenant_id, code, name, kind, sessions, valid_days, price)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, tenantId, t.code, t.name, t.kind, t.sessions, t.days, t.price],
    );
  }

  // --- hoa hồng: mặc định của phòng, cả hai loại ---
  await db.query(
    `INSERT INTO commission_policy
       (tenant_id, sale_pct, teach_mode, teach_fixed_amount, effective_from)
     VALUES ($1, 8.00, 'FIXED', 80000, current_date - 365)`,
    [tenantId],
  );
  // PT senior ăn cao hơn -> dòng riêng, cụ thể hơn nên thắng khi phân giải
  await db.query(
    `INSERT INTO commission_policy
       (tenant_id, trainer_id, sale_pct, teach_mode, teach_fixed_amount, effective_from)
     VALUES ($1, $2, 10.00, 'FIXED', 120000, current_date - 365)`,
    [tenantId, trainerIds[0]],
  );

  // --- chiến dịch ---
  await db.query(
    `INSERT INTO campaign (tenant_id, code, name, trigger_type, threshold, channel, template_code)
     VALUES ($1,'LOW_BAL','Gói sắp hết buổi','LOW_SESSION_BALANCE',3,'ZALO_ZNS','PACKAGE_LOW_BALANCE'),
            ($1,'EXPIRING','Gói sắp hết hạn','PACKAGE_EXPIRING',7,'ZALO_ZNS','PACKAGE_EXPIRING')`,
    [tenantId],
  );

  return { tenantId, trainerIds, memberIds, ...{ templateIds } } as never;
}

/** Bán một gói rồi tập một buổi — chạy trọn chuỗi sổ cái -> doanh thu -> hoa hồng. */
async function sellAndTrain(db: Client, tenantId: string, memberId: string, trainerId: string) {
  const tpl = await db.query<{ id: string; price: string; sessions: number; name: string }>(
    `SELECT id, price, sessions, name FROM package_template
     WHERE tenant_id = $1 AND code = 'PT10'`,
    [tenantId],
  );
  const t = tpl.rows[0]!;
  const price = Number(t.price);
  const mpId = randomUUID();

  await db.query(
    `INSERT INTO member_package
       (id, tenant_id, member_id, template_id, code, name_snapshot, price_gross, discount,
        sessions_total, sold_by_id, trainer_id, starts_on, expires_on)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$9,$9, current_date, current_date + 90)`,
    [mpId, tenantId, memberId, t.id, 'HD0001', t.name, price, t.sessions, trainerId],
  );
  await db.query(
    `INSERT INTO session_ledger (tenant_id, member_package_id, delta, reason, ref_type, ref_id)
     VALUES ($1,$2,$3,'PURCHASE','MEMBER_PACKAGE',$2)`,
    [tenantId, mpId, t.sessions],
  );

  // --- hoá đơn trả góp 2 đợt, mới thu đợt 1 ---
  const invId = randomUUID();
  await db.query(
    `INSERT INTO invoice (id, tenant_id, member_id, code, total_amount, paid_amount,
                          status, is_installment)
     VALUES ($1,$2,$3,'HD-0001',$4,$5,'PARTIALLY_PAID', true)`,
    [invId, tenantId, memberId, price, price / 2],
  );
  await db.query(
    `INSERT INTO invoice_item (tenant_id, invoice_id, member_package_id, description, unit_price, amount)
     VALUES ($1,$2,$3,$4,$5,$5)`,
    [tenantId, invId, mpId, t.name, price],
  );
  const sch1 = randomUUID();
  const sch2 = randomUUID();
  await db.query(
    `INSERT INTO payment_schedule (id, tenant_id, invoice_id, seq, due_date, amount, status)
     VALUES ($1,$3,$4,1, current_date,      $5,'PAID'),
            ($2,$3,$4,2, current_date + 30, $5,'DUE')`,
    [sch1, sch2, tenantId, invId, price / 2],
  );
  const payId = randomUUID();
  await db.query(
    `INSERT INTO payment (id, tenant_id, invoice_id, schedule_id, amount, method)
     VALUES ($1,$2,$3,$4,$5,'BANK_TRANSFER')`,
    [payId, tenantId, invId, sch1, price / 2],
  );
  // Hoa hồng BÁN tính trên tiền THỰC THU -> trả góp thì mỗi đợt một dòng.
  await db.query(
    `INSERT INTO commission_entry
       (tenant_id, trainer_id, kind, member_package_id, payment_id, base_amount, amount,
        policy_snapshot, period_month)
     VALUES ($1,$2,'SALE',$3,$4,$5,$6,$7, date_trunc('month', now())::date)`,
    [tenantId, trainerId, mpId, payId, price / 2, Math.round((price / 2) * 0.1),
     JSON.stringify({ sale_pct: 10.0, source: 'seed' })],
  );

  // --- một buổi đã tập ---
  const bkId = randomUUID();
  await db.query(
    `INSERT INTO booking (id, tenant_id, member_package_id, member_id, trainer_id,
                          starts_at, ends_at, status, checkin_at, checkin_method, deducted)
     VALUES ($1,$2,$3,$4,$5, now() - interval '2 hours', now() - interval '1 hour',
             'COMPLETED', now() - interval '2 hours', 'QR', true)`,
    [bkId, tenantId, mpId, memberId, trainerId],
  );
  await db.query(
    `INSERT INTO session_ledger (tenant_id, member_package_id, delta, reason, ref_type, ref_id)
     VALUES ($1,$2,-1,'CHECKIN','BOOKING',$3)`,
    [tenantId, mpId, bkId],
  );
  await db.query(`UPDATE member_package SET sessions_used = 1 WHERE id = $1`, [mpId]);

  const unit = Math.round(price / t.sessions);
  await db.query(
    `INSERT INTO revenue_entry (tenant_id, member_package_id, booking_id, trainer_id, amount)
     VALUES ($1,$2,$3,$4,$5)`,
    [tenantId, mpId, bkId, trainerId, unit],
  );
  await db.query(
    `INSERT INTO commission_entry
       (tenant_id, trainer_id, kind, member_package_id, booking_id, base_amount, amount,
        policy_snapshot, period_month)
     VALUES ($1,$2,'TEACH',$3,$4,$5,120000,$6, date_trunc('month', now())::date)`,
    [tenantId, trainerId, mpId, bkId, unit,
     JSON.stringify({ teach_mode: 'FIXED', teach_fixed_amount: 120000, source: 'seed' })],
  );
}

async function main() {
  const url = process.env.DATABASE_URL_PLATFORM;
  if (!url) throw new Error('Thiếu DATABASE_URL_PLATFORM (xem .env.example)');
  const db = new Client({ connectionString: url });
  await db.connect();

  try {
    const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM tenant');
    if (Number(rows[0]!.n) > 0) {
      console.log('Đã có tenant — bỏ qua seed. Xoá sạch bằng: pnpm infra:reset');
      return;
    }

    await db.query(
      `INSERT INTO plan (code, name, max_trainers, max_members, max_messages_month, price_monthly, sort_order)
       VALUES ('FREE','Dùng thử',  2,   50,   200,        0, 1),
              ('BASIC','Cơ bản',   5,  300,  2000,  990000, 2),
              ('PRO','Chuyên nghiệp', 20, 2000, 20000, 2990000, 3)`,
    );

    const hash = await bcrypt.hash(PASSWORD, 10);
    const ctx: Ctx = { db, hash };

    const a = await makeTenant(ctx, 'gym-alpha', 'Alpha Fitness', 1);
    const b = await makeTenant(ctx, 'gym-beta', 'Beta Gym', 2);

    await sellAndTrain(db, a.tenantId, a.memberIds[0]!, a.trainerIds[0]!);
    await sellAndTrain(db, b.tenantId, b.memberIds[0]!, b.trainerIds[0]!);

    console.log('Seed xong. Hai phòng tập:');
    console.log(`  gym-alpha  ${a.tenantId}`);
    console.log(`  gym-beta   ${b.tenantId}`);
    console.log(`Đăng nhập dev: +84901000001 / ${PASSWORD} (chủ phòng Alpha)`);
    console.log(`               +84902000001 / ${PASSWORD} (chủ phòng Beta)`);
  } finally {
    await db.end();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
