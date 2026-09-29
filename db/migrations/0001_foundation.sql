-- =============================================================================
-- 0001 — Nền multi-tenant: tenant, định danh toàn cục, vai trò theo phòng,
--        đăng nhập, gói SaaS. RLS được bật ở 0005, KHÔNG bật ở đây.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- cần cho EXCLUDE trên booking (0002)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tự cập nhật updated_at. Dùng lại cho mọi bảng có cột này.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;

-- =============================================================================
-- BẢNG TOÀN CỤC — không có tenant_id, không RLS.
-- Danh sách này được test cách ly chốt cứng; thêm bảng vào đây phải giải trình
-- trong pull request.
-- =============================================================================

CREATE TABLE tenant (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       citext NOT NULL UNIQUE,
  name       text   NOT NULL,
  timezone   text   NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency   char(3) NOT NULL DEFAULT 'VND',
  status     text   NOT NULL DEFAULT 'TRIAL'
             CHECK (status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CLOSED')),
  logo_key   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- slug là subdomain: 3..40 ký tự, không mở/đóng bằng dấu gạch
  CONSTRAINT tenant_slug_shape CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  -- chặn slug đụng hạ tầng. Ràng buộc vĩnh viễn nên đặt ở DB, không ở validate form.
  CONSTRAINT tenant_slug_reserved CHECK (
    lower(slug) NOT IN ('www','api','admin','app','static','cdn','assets','mail','status','help','docs')
  )
);
CREATE TRIGGER trg_tenant_updated BEFORE UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Một người = một định danh, dùng chung cho nhiều phòng tập.
-- Người tập chuyển phòng / PT dạy hai nơi đều không phải tạo tài khoản mới.
CREATE TABLE identity (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone             text NOT NULL UNIQUE,
  email             citext UNIQUE,
  full_name         text NOT NULL,
  password_hash     text,                       -- NULL = chỉ đăng nhập bằng OTP
  phone_verified_at timestamptz,
  last_login_at     timestamptz,
  status            text NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE','LOCKED','DELETED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  -- E.164. Phải chuẩn hoá TRƯỚC khi ghi: '0912...' và '+84912...' là hai người
  -- khác nhau với UNIQUE ở trên, và đó là lớp lỗi rất khó gỡ về sau.
  CONSTRAINT identity_phone_e164 CHECK (phone ~ '^\+[1-9][0-9]{7,14}$')
);
CREATE TRIGGER trg_identity_updated BEFORE UPDATE ON identity
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Đổi số điện thoại giữ lại vết: tra cứu lịch sử vẫn ra đúng người.
CREATE TABLE identity_phone_history (
  id          bigserial PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  old_phone   text NOT NULL,
  new_phone   text NOT NULL,
  changed_by  uuid REFERENCES identity(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);

-- Vai trò của một định danh TẠI một phòng. Một người có thể vừa là PT ở phòng A
-- vừa là member ở phòng B — khoá chính ba cột cho phép điều đó.
CREATE TABLE tenant_user (
  tenant_id   uuid NOT NULL REFERENCES tenant(id)   ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('OWNER','ADMIN','RECEPTION','PT','MEMBER')),
  status      text NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('ACTIVE','SUSPENDED','LEFT')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, identity_id, role)
);
CREATE INDEX ix_tenant_user_identity ON tenant_user (identity_id) WHERE status = 'ACTIVE';
-- Mỗi phòng phải có đúng một OWNER đang hoạt động.
CREATE UNIQUE INDEX uq_tenant_single_owner ON tenant_user (tenant_id)
  WHERE role = 'OWNER' AND status = 'ACTIVE';

-- OTP đăng nhập. Chạy TRƯỚC khi có tenant context nên nằm ở lớp toàn cục.
CREATE TABLE otp_challenge (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone       text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('LOGIN','VERIFY_PHONE','RESET_PASSWORD')),
  code_hash   text NOT NULL,          -- KHÔNG lưu mã thô, kể cả ở dev
  expires_at  timestamptz NOT NULL,
  attempts    int  NOT NULL DEFAULT 0,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_otp_lookup ON otp_challenge (phone, purpose, created_at DESC);

-- Refresh token xoay vòng. `family_id` để phát hiện tái sử dụng: token đã bị
-- thay mà vẫn được dùng nghĩa là bị đánh cắp => thu hồi CẢ HỌ token.
CREATE TABLE refresh_token (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id    uuid NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  tenant_id      uuid REFERENCES tenant(id) ON DELETE CASCADE,  -- NULL = chưa chọn phòng
  token_hash     text NOT NULL UNIQUE,
  family_id      uuid NOT NULL,
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  revoked_reason text,
  replaced_by    uuid REFERENCES refresh_token(id),
  user_agent     text,
  ip             inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_family ON refresh_token (family_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_refresh_identity ON refresh_token (identity_id, expires_at);

-- Quản trị nền tảng (chủ sản phẩm), trên tất cả tenant.
CREATE TABLE platform_admin (
  identity_id uuid PRIMARY KEY REFERENCES identity(id) ON DELETE CASCADE,
  level       text NOT NULL DEFAULT 'SUPPORT' CHECK (level IN ('SUPPORT','OPS','SUPER')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Con đường DUY NHẤT nhìn xuyên tenant. Mọi thao tác qua role app_platform ghi
-- ở đây, kể cả thao tác chỉ đọc.
CREATE TABLE platform_audit_log (
  id            bigserial PRIMARY KEY,
  actor_id      uuid REFERENCES identity(id),
  target_tenant uuid REFERENCES tenant(id),
  action        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}',
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_platform_audit_tenant ON platform_audit_log (target_tenant, created_at DESC);

-- ---- Gói SaaS (phòng gym trả tiền cho nền tảng) -----------------------------

CREATE TABLE plan (
  code               text PRIMARY KEY,
  name               text NOT NULL,
  max_trainers       int,                -- NULL = không giới hạn
  max_members        int,
  max_messages_month int,
  price_monthly      bigint NOT NULL CHECK (price_monthly >= 0),   -- VND
  features           jsonb  NOT NULL DEFAULT '{}',
  is_public          boolean NOT NULL DEFAULT true,
  sort_order         int NOT NULL DEFAULT 0
);

CREATE TABLE tenant_subscription (
  tenant_id            uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  plan_code            text NOT NULL REFERENCES plan(code),
  status               text NOT NULL DEFAULT 'TRIALING'
                       CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','CANCELLED')),
  trial_ends_at        timestamptz,
  current_period_start date,
  current_period_end   date,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subscription_updated BEFORE UPDATE ON tenant_subscription
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Thu tiền SaaS bằng chuyển khoản thủ công: admin nền tảng đối chiếu rồi kích hoạt.
CREATE TABLE tenant_billing_record (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end   date NOT NULL,
  plan_code    text NOT NULL REFERENCES plan(code),
  amount       bigint NOT NULL CHECK (amount >= 0),
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','PAID','WAIVED','VOID')),
  transfer_ref text,                                  -- nội dung chuyển khoản
  confirmed_by uuid REFERENCES identity(id),          -- admin nền tảng đã đối chiếu
  confirmed_at timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_period_order CHECK (period_end >= period_start),
  -- PAID thì bắt buộc biết ai xác nhận và lúc nào. Không có "đã thu" vô danh.
  CONSTRAINT billing_paid_needs_confirmation CHECK (
    status <> 'PAID' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uq_billing_period ON tenant_billing_record (tenant_id, period_start);

-- =============================================================================
-- BẢNG THEO TENANT — từ đây mọi bảng đều có tenant_id và sẽ bị RLS áp (0005)
-- =============================================================================

-- Chính sách vận hành mặc định của phòng. package_template ghi đè được từng ô
-- (0002); thứ tự phân giải là COALESCE(gói, phòng) — xem resolve_booking_policy.
CREATE TABLE tenant_policy (
  tenant_id             uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  late_cancel_hours     int     NOT NULL DEFAULT 12 CHECK (late_cancel_hours >= 0),
  late_cancel_deducts   boolean NOT NULL DEFAULT true,
  no_show_deducts       boolean NOT NULL DEFAULT true,
  booking_window_days   int     NOT NULL DEFAULT 30 CHECK (booking_window_days > 0),
  checkin_grace_minutes int     NOT NULL DEFAULT 30 CHECK (checkin_grace_minutes >= 0),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_tenant_policy_updated BEFORE UPDATE ON tenant_policy
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  actor_id   uuid REFERENCES identity(id),
  action     text NOT NULL,
  entity     text NOT NULL,
  entity_id  text,
  before     jsonb,
  after      jsonb,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_tenant_time ON audit_log (tenant_id, created_at DESC);
CREATE INDEX ix_audit_entity ON audit_log (tenant_id, entity, entity_id);
