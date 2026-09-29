-- =============================================================================
-- 0002 — Lõi nghiệp vụ: hội viên, PT, gói tập, sổ cái buổi, lịch, doanh thu,
--        hoa hồng.
--
-- QUY ƯỚC KHOÁ NGOẠI (áp dụng toàn bộ file này):
--   Mỗi bảng có tenant_id đều khai UNIQUE (tenant_id, id) làm "neo", và mọi
--   khoá ngoại giữa hai bảng có tenant đều là khoá GHÉP (tenant_id, <fk>).
--   Lý do: FK thường KHÔNG chặn tham chiếu chéo tenant — một bug ở tầng service
--   vẫn tạo được dòng của phòng A trỏ sang dữ liệu phòng B, và Postgres chấp
--   nhận. RLS chặn ĐỌC, khoá ghép chặn GHI SAI. Cần cả hai.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Hội viên & huấn luyện viên
-- ---------------------------------------------------------------------------

CREATE TABLE member (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id  uuid NOT NULL REFERENCES identity(id),
  code         text NOT NULL,
  dob          date,
  gender       text CHECK (gender IN ('MALE','FEMALE','OTHER')),
  source       text,                    -- WALK_IN | REFERRAL | ZALO | FACEBOOK | ...
  referred_by  uuid,                    -- hội viên giới thiệu (cùng tenant)
  avatar_key   text,                    -- khoá S3
  -- uid Zalo trên OA CỦA CHÍNH PHÒNG NÀY. Mỗi phòng một OA nên uid không dùng
  -- chung được giữa các tenant — đây là lý do cột nằm ở đây chứ không ở identity.
  zalo_user_id text,
  status       text NOT NULL DEFAULT 'ACTIVE'
               CHECK (status IN ('ACTIVE','INACTIVE','BANNED')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_member_anchor   UNIQUE (tenant_id, id),
  CONSTRAINT uq_member_code     UNIQUE (tenant_id, code),
  CONSTRAINT uq_member_identity UNIQUE (tenant_id, identity_id),
  CONSTRAINT fk_member_referrer FOREIGN KEY (tenant_id, referred_by)
    REFERENCES member (tenant_id, id)
);
CREATE INDEX ix_member_tenant ON member (tenant_id);
CREATE INDEX ix_member_zalo ON member (tenant_id, zalo_user_id) WHERE zalo_user_id IS NOT NULL;
CREATE TRIGGER trg_member_updated BEFORE UPDATE ON member
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE trainer (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identity(id),
  code        text NOT NULL,
  level       text,                     -- JUNIOR | SENIOR | MASTER ...
  bio         text,
  avatar_key  text,
  base_salary bigint NOT NULL DEFAULT 0 CHECK (base_salary >= 0),
  hired_on    date,
  left_on     date,
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_trainer_anchor   UNIQUE (tenant_id, id),
  CONSTRAINT uq_trainer_code     UNIQUE (tenant_id, code),
  CONSTRAINT uq_trainer_identity UNIQUE (tenant_id, identity_id),
  CONSTRAINT trainer_left_after_hired CHECK (left_on IS NULL OR hired_on IS NULL OR left_on >= hired_on)
);
CREATE INDEX ix_trainer_tenant ON trainer (tenant_id);
CREATE TRIGGER trg_trainer_updated BEFORE UPDATE ON trainer
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Khung giờ PT nhận dạy. Member chỉ đặt được trong khung này.
CREATE TABLE trainer_availability (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_id uuid NOT NULL,
  weekday    smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6),   -- 0 = Chủ nhật
  start_time time NOT NULL,
  end_time   time NOT NULL,
  CONSTRAINT availability_time_order CHECK (end_time > start_time),
  CONSTRAINT fk_availability_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_availability_trainer ON trainer_availability (tenant_id, trainer_id, weekday);

-- ---------------------------------------------------------------------------
-- Gói tập
-- ---------------------------------------------------------------------------

CREATE TABLE package_template (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('PT','GYM','COMBO','CLASS')),
  sessions    int    NOT NULL CHECK (sessions > 0),
  valid_days  int    NOT NULL CHECK (valid_days > 0),
  price       bigint NOT NULL CHECK (price >= 0),
  description text,
  -- Ghi đè chính sách của phòng. NULL = dùng mặc định ở tenant_policy.
  -- Phân giải bằng resolve_booking_policy() phía dưới — đừng COALESCE rải rác.
  late_cancel_hours   int     CHECK (late_cancel_hours >= 0),
  late_cancel_deducts boolean,
  no_show_deducts     boolean,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_pkg_template_anchor UNIQUE (tenant_id, id),
  CONSTRAINT uq_pkg_template_code   UNIQUE (tenant_id, code)
);
CREATE INDEX ix_pkg_template_tenant ON package_template (tenant_id);
CREATE TRIGGER trg_pkg_template_updated BEFORE UPDATE ON package_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Hợp đồng đã bán. Giá và số buổi là SNAPSHOT: đổi bảng giá tháng sau không
-- được làm đổi doanh số của hợp đồng cũ, nên tuyệt đối không join ngược
-- package_template để lấy giá khi tính tiền.
CREATE TABLE member_package (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id      uuid NOT NULL,
  template_id    uuid NOT NULL,
  code           text NOT NULL,

  name_snapshot  text   NOT NULL,
  price_gross    bigint NOT NULL CHECK (price_gross >= 0),
  discount       bigint NOT NULL DEFAULT 0 CHECK (discount >= 0),
  price_net      bigint GENERATED ALWAYS AS (price_gross - discount) STORED,
  sessions_total int    NOT NULL CHECK (sessions_total > 0),
  -- Bản cache của sổ cái. LUÔN ghi trong cùng transaction với session_ledger.
  sessions_used  int    NOT NULL DEFAULT 0,

  sold_by_id     uuid,          -- PT BÁN  -> hoa hồng SALE, tính theo tiền THU được
  trainer_id     uuid,          -- PT DẠY  -> hoa hồng TEACH, đổi được giữa chừng
  starts_on      date NOT NULL,
  expires_on     date NOT NULL,
  -- Ngày hết hạn đã được cộng bù các đợt đóng băng; xem package_freeze.
  frozen_days    int  NOT NULL DEFAULT 0 CHECK (frozen_days >= 0),
  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','FROZEN','EXPIRED','USED_UP','REFUNDED','CANCELLED')),
  created_by     uuid REFERENCES identity(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_mp_anchor        UNIQUE (tenant_id, id),
  CONSTRAINT uq_mp_code          UNIQUE (tenant_id, code),
  -- Neo ba cột: cho phép booking ràng buộc member_id khớp với gói ở tầng DB.
  CONSTRAINT uq_mp_member_anchor UNIQUE (tenant_id, id, member_id),
  CONSTRAINT mp_sessions_range   CHECK (sessions_used BETWEEN 0 AND sessions_total),
  CONSTRAINT mp_discount_le_gross CHECK (discount <= price_gross),
  CONSTRAINT mp_date_order       CHECK (expires_on >= starts_on),
  CONSTRAINT fk_mp_member   FOREIGN KEY (tenant_id, member_id)   REFERENCES member (tenant_id, id),
  CONSTRAINT fk_mp_template FOREIGN KEY (tenant_id, template_id) REFERENCES package_template (tenant_id, id),
  CONSTRAINT fk_mp_seller   FOREIGN KEY (tenant_id, sold_by_id)  REFERENCES trainer (tenant_id, id),
  CONSTRAINT fk_mp_trainer  FOREIGN KEY (tenant_id, trainer_id)  REFERENCES trainer (tenant_id, id)
);
CREATE INDEX ix_mp_tenant  ON member_package (tenant_id);
CREATE INDEX ix_mp_member  ON member_package (tenant_id, member_id);
CREATE INDEX ix_mp_trainer ON member_package (tenant_id, trainer_id) WHERE status = 'ACTIVE';
-- Phục vụ campaign "gói sắp hết": quét theo hạn và số buổi còn lại.
CREATE INDEX ix_mp_low_balance ON member_package (tenant_id, expires_on)
  WHERE status = 'ACTIVE';
CREATE TRIGGER trg_mp_updated BEFORE UPDATE ON member_package
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Đóng băng gói (ốm, đi công tác). Mở lại thì cộng bù vào expires_on.
CREATE TABLE package_freeze (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_package_id uuid NOT NULL,
  frozen_from       date NOT NULL,
  frozen_to         date,                -- NULL = đang đóng băng
  reason            text,
  created_by        uuid REFERENCES identity(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT freeze_date_order CHECK (frozen_to IS NULL OR frozen_to >= frozen_from),
  CONSTRAINT fk_freeze_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id) ON DELETE CASCADE
);
-- Một gói chỉ có một đợt đóng băng đang mở.
CREATE UNIQUE INDEX uq_freeze_open ON package_freeze (member_package_id)
  WHERE frozen_to IS NULL;

-- ---------------------------------------------------------------------------
-- SỔ CÁI BUỔI TẬP — nguồn sự thật, chỉ ghi thêm, không sửa, không xoá.
-- member_package.sessions_used chỉ là bản cache để truy vấn nhanh.
-- ---------------------------------------------------------------------------

CREATE TABLE session_ledger (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_package_id uuid NOT NULL,
  delta             int  NOT NULL CHECK (delta <> 0),   -- +10 mua, -1 điểm danh, +1 hoàn
  reason            text NOT NULL CHECK (reason IN (
                      'PURCHASE','CHECKIN','REVOKE_CHECKIN','NO_SHOW','LATE_CANCEL',
                      'BONUS','ADJUSTMENT','TRANSFER_IN','TRANSFER_OUT','EXPIRE','REFUND')),
  ref_type          text,
  ref_id            uuid,
  note              text,
  created_by        uuid REFERENCES identity(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_ledger_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id)
);
CREATE INDEX ix_ledger_mp ON session_ledger (member_package_id, created_at);
-- Chống trừ hai lần cho cùng một buổi. Idempotency ở tầng DB, không ở tầng service:
-- hai thiết bị bấm check-in cùng lúc thì một cái vỡ ở đây, đúng như mong muốn.
CREATE UNIQUE INDEX uq_ledger_checkin ON session_ledger (ref_type, ref_id)
  WHERE reason = 'CHECKIN';

-- ---------------------------------------------------------------------------
-- Lịch tập & điểm danh
-- ---------------------------------------------------------------------------

CREATE TABLE booking (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_package_id uuid NOT NULL,
  member_id         uuid NOT NULL,   -- suy từ gói, ràng buộc khớp bằng FK ba cột
  trainer_id        uuid NOT NULL,
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'BOOKED' CHECK (status IN (
                      'BOOKED','CHECKED_IN','COMPLETED','NO_SHOW',
                      'CANCELLED_BY_MEMBER','CANCELLED_BY_PT','CANCELLED_BY_STAFF')),
  checkin_at        timestamptz,
  checkin_method    text CHECK (checkin_method IN ('QR','PT_CONFIRM','MEMBER_CONFIRM','ADMIN')),
  checkin_by        uuid REFERENCES identity(id),
  cancelled_at      timestamptz,
  cancelled_by      uuid REFERENCES identity(id),
  cancel_reason     text,
  -- Buổi này có trừ số buổi của gói không (đã áp chính sách lúc chốt trạng thái).
  deducted          boolean NOT NULL DEFAULT false,
  note              text,
  created_by        uuid REFERENCES identity(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_booking_anchor UNIQUE (tenant_id, id),
  CONSTRAINT booking_time_order CHECK (ends_at > starts_at),
  CONSTRAINT booking_checkin_fields CHECK (
    (status <> 'CHECKED_IN' AND status <> 'COMPLETED') OR checkin_at IS NOT NULL
  ),
  -- FK BA CỘT: ép booking.member_id luôn khớp member của gói. Không có cách nào
  -- tạo được buổi tập trừ vào gói của người khác.
  CONSTRAINT fk_booking_mp FOREIGN KEY (tenant_id, member_package_id, member_id)
    REFERENCES member_package (tenant_id, id, member_id),
  CONSTRAINT fk_booking_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id)
);
CREATE INDEX ix_booking_trainer_time ON booking (tenant_id, trainer_id, starts_at);
CREATE INDEX ix_booking_member_time  ON booking (tenant_id, member_id, starts_at DESC);
CREATE INDEX ix_booking_mp ON booking (member_package_id);
CREATE TRIGGER trg_booking_updated BEFORE UPDATE ON booking
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Một PT không thể có hai buổi chồng giờ; một hội viên cũng vậy.
-- Ràng buộc ở DB chứ không ở validator: validator thua ở hai request song song.
ALTER TABLE booking ADD CONSTRAINT excl_booking_trainer_overlap
  EXCLUDE USING gist (
    tenant_id  WITH =,
    trainer_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('BOOKED','CHECKED_IN','COMPLETED'));

ALTER TABLE booking ADD CONSTRAINT excl_booking_member_overlap
  EXCLUDE USING gist (
    tenant_id WITH =,
    member_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (status IN ('BOOKED','CHECKED_IN','COMPLETED'));

-- Mã QR điểm danh, xoay vòng. PT mở buổi -> sinh mã -> member quét.
-- Mã hết hạn sau vài chục giây nên chụp màn hình gửi cho nhau không dùng được.
CREATE TABLE checkin_token (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_checkin_token_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES booking (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_checkin_token_booking ON checkin_token (booking_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- DOANH THU GHI NHẬN (accrual) — theo BUỔI ĐÃ DÙNG, không theo ngày thu tiền.
-- Tiền thu nằm ở payment (0003). Hai con số khác nhau, cố ý không gộp.
-- ---------------------------------------------------------------------------

CREATE TABLE revenue_entry (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_package_id uuid NOT NULL,
  booking_id        uuid NOT NULL,
  -- PT DẠY buổi đó, chốt tại thời điểm buổi diễn ra. Đổi PT phụ trách gói sau
  -- này KHÔNG được làm đổi doanh số quá khứ.
  trainer_id        uuid NOT NULL,
  amount            bigint NOT NULL CHECK (amount >= 0),
  recognized_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_rev_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id),
  CONSTRAINT fk_rev_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES booking (tenant_id, id),
  CONSTRAINT fk_rev_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id)
);
-- Một buổi ghi nhận đúng một lần.
CREATE UNIQUE INDEX uq_revenue_booking ON revenue_entry (booking_id);
CREATE INDEX ix_revenue_trainer_time ON revenue_entry (tenant_id, trainer_id, recognized_at);

-- ---------------------------------------------------------------------------
-- HOA HỒNG — hai loại, cả hai đều dùng:
--   SALE  : % trên tiền THỰC THU (gắn với payment). Trả góp thì mỗi đợt thu
--           sinh một dòng, tự động đúng tỉ lệ — đây là lý do gắn vào payment
--           chứ không gắn vào hoá đơn.
--   TEACH : theo buổi đã dạy. FIXED (VND/buổi) hoặc PCT (% đơn giá buổi).
-- ---------------------------------------------------------------------------

CREATE TABLE commission_policy (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_id          uuid,          -- NULL = mặc định của phòng
  package_template_id uuid,          -- NULL = áp cho mọi gói
  sale_pct            numeric(5,2) NOT NULL DEFAULT 0 CHECK (sale_pct BETWEEN 0 AND 100),
  teach_mode          text NOT NULL DEFAULT 'FIXED' CHECK (teach_mode IN ('FIXED','PCT')),
  teach_fixed_amount  bigint NOT NULL DEFAULT 0 CHECK (teach_fixed_amount >= 0),
  teach_pct           numeric(5,2) NOT NULL DEFAULT 0 CHECK (teach_pct BETWEEN 0 AND 100),
  effective_from      date NOT NULL,
  effective_to        date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comm_policy_date_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT fk_comm_policy_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_comm_policy_template FOREIGN KEY (tenant_id, package_template_id)
    REFERENCES package_template (tenant_id, id) ON DELETE CASCADE
);
-- Một tổ hợp (PT, gói) chỉ có một chính sách đang mở tại một thời điểm.
CREATE UNIQUE INDEX uq_comm_policy_open ON commission_policy (
  tenant_id,
  COALESCE(trainer_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(package_template_id, '00000000-0000-0000-0000-000000000000'::uuid),
  effective_from
);

CREATE TABLE commission_entry (
  id                bigserial PRIMARY KEY,
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  trainer_id        uuid NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('SALE','TEACH')),
  member_package_id uuid NOT NULL,
  payment_id        uuid,     -- kind = SALE
  booking_id        uuid,     -- kind = TEACH
  base_amount       bigint NOT NULL CHECK (base_amount >= 0),
  amount            bigint NOT NULL CHECK (amount >= 0),
  -- Chốt chính sách tại thời điểm tính. Sửa commission_policy về sau KHÔNG
  -- được làm đổi hoa hồng đã ghi — cùng nguyên tắc snapshot giá của gói.
  policy_snapshot   jsonb  NOT NULL,
  earned_at         timestamptz NOT NULL DEFAULT now(),
  -- Kỳ trả lương, cắt theo giờ Việt Nam. Buổi 6h sáng ngày 1 theo giờ VN là 23h
  -- ngày 30 theo UTC; gộp theo UTC là lệch đúng những ngày đầu/cuối tháng.
  period_month      date NOT NULL,
  paid_out_at       timestamptz,
  CONSTRAINT comm_kind_fields CHECK (
    (kind = 'SALE'  AND payment_id IS NOT NULL AND booking_id IS NULL) OR
    (kind = 'TEACH' AND booking_id IS NOT NULL AND payment_id IS NULL)
  ),
  CONSTRAINT fk_comm_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id),
  CONSTRAINT fk_comm_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id),
  CONSTRAINT fk_comm_booking FOREIGN KEY (tenant_id, booking_id)
    REFERENCES booking (tenant_id, id)
);
-- Idempotency: một lần thu = một dòng SALE cho một PT; một buổi = một dòng TEACH.
CREATE UNIQUE INDEX uq_comm_sale  ON commission_entry (payment_id, trainer_id) WHERE kind = 'SALE';
CREATE UNIQUE INDEX uq_comm_teach ON commission_entry (booking_id)             WHERE kind = 'TEACH';
CREATE INDEX ix_comm_payroll ON commission_entry (tenant_id, trainer_id, period_month);

-- ---------------------------------------------------------------------------
-- Tệp trên S3. Bucket private; đọc qua presigned GET hạn ngắn.
-- ---------------------------------------------------------------------------

CREATE TABLE file_object (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  bucket      text NOT NULL,
  -- Khoá LUÔN mở đầu bằng 't/<tenant_id>/' — xem StorageService.buildKey.
  -- Tiền tố này là lớp cách ly thứ hai, độc lập với RLS.
  object_key  text NOT NULL,
  mime        text NOT NULL,
  size_bytes  bigint NOT NULL CHECK (size_bytes >= 0),
  owner_type  text NOT NULL,     -- MEMBER_AVATAR | PROGRESS_PHOTO | INVOICE_PDF | CONTRACT ...
  owner_id    uuid,
  uploaded_by uuid REFERENCES identity(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_file_key UNIQUE (bucket, object_key),
  CONSTRAINT file_key_tenant_prefix CHECK (object_key LIKE 't/' || tenant_id::text || '/%')
);
CREATE INDEX ix_file_owner ON file_object (tenant_id, owner_type, owner_id);

-- ---------------------------------------------------------------------------
-- Phân giải chính sách huỷ/vắng: gói ghi đè phòng, từng ô một.
-- MỘT nguồn duy nhất. Đừng COALESCE rải rác trong service — ba chỗ COALESCE
-- là ba cơ hội để chúng trôi khỏi nhau.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_booking_policy(p_tenant uuid, p_template uuid)
RETURNS TABLE (
  late_cancel_hours   int,
  late_cancel_deducts boolean,
  no_show_deducts     boolean
)
LANGUAGE sql STABLE AS $fn$
  SELECT
    COALESCE(pt.late_cancel_hours,   tp.late_cancel_hours),
    COALESCE(pt.late_cancel_deducts, tp.late_cancel_deducts),
    COALESCE(pt.no_show_deducts,     tp.no_show_deducts)
  FROM tenant_policy tp
  LEFT JOIN package_template pt
         ON pt.tenant_id = tp.tenant_id AND pt.id = p_template
  WHERE tp.tenant_id = p_tenant;
$fn$;
