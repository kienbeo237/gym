-- =============================================================================
-- 0004 — Thông báo (Zalo OA theo từng phòng) và chiến dịch chăm sóc.
--
-- Mỗi phòng gym có OA RIÊNG. Hệ quả: credential theo tenant, hạn mức theo
-- tenant, và template ZNS phải được duyệt riêng cho từng OA — cùng một
-- template_code sẽ có provider_tpl_id khác nhau ở mỗi phòng.
-- =============================================================================

CREATE TABLE tenant_zalo_oa (
  tenant_id         uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE CASCADE,
  oa_id             text NOT NULL,
  app_id            text NOT NULL,
  -- Mã hoá phong bì bằng TENANT_SECRET_KEY. KHÔNG bao giờ lưu thô, kể cả ở dev:
  -- một lần dump DB dev gửi qua chat là mất OA của khách hàng.
  secret_enc        bytea NOT NULL,
  access_token_enc  bytea,
  refresh_token_enc bytea,
  token_expires_at  timestamptz,
  status            text NOT NULL DEFAULT 'DISCONNECTED'
                    CHECK (status IN ('DISCONNECTED','CONNECTED','TOKEN_EXPIRED','ERROR')),
  last_error        text,
  connected_at      timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_zalo_oa_updated BEFORE UPDATE ON tenant_zalo_oa
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE tenant_zns_template (
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  template_code   text NOT NULL,        -- mã nội bộ, giống nhau ở mọi tenant
  provider_tpl_id text,                 -- mã do Zalo cấp, KHÁC nhau ở mỗi tenant
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','DISABLED')),
  reject_reason   text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, template_code),
  CONSTRAINT zns_approved_needs_id CHECK (status <> 'APPROVED' OR provider_tpl_id IS NOT NULL)
);
CREATE TRIGGER trg_zns_template_updated BEFORE UPDATE ON tenant_zns_template
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- HỘP THƯ ĐI (outbox).
-- Ghi TRONG cùng transaction nghiệp vụ; worker gửi ở tiến trình khác.
-- Không bao giờ gọi HTTP tới Zalo bên trong transaction: mạng chậm thì transaction
-- treo và giữ khoá trên member_package, kéo sập cả luồng điểm danh.
-- ---------------------------------------------------------------------------

CREATE TABLE notification_outbox (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('ZALO_ZNS','ZALO_OA','SMS','EMAIL','INAPP')),
  template_code   text NOT NULL,
  recipient_ref   text NOT NULL,        -- zalo uid / số điện thoại / email
  member_id       uuid,
  payload         jsonb NOT NULL DEFAULT '{}',
  -- Chặn gửi trùng khi worker thử lại hoặc cron chạy lại.
  -- Quy ước đặt khoá: '<SU_KIEN>:<id gốc>' — xem bảng ánh xạ trong README.
  idempotency_key text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SENDING','SENT','FAILED','SKIPPED')),
  attempts        int  NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_msg_id text,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fk_outbox_member FOREIGN KEY (tenant_id, member_id)
    REFERENCES member (tenant_id, id) ON DELETE SET NULL
);
-- Khoá chống trùng có phạm vi theo tenant: hai phòng có thể có cùng chuỗi khoá.
CREATE UNIQUE INDEX uq_outbox_idem ON notification_outbox (tenant_id, idempotency_key);
-- Worker quét theo index này; partial để không phải đọc lịch sử đã gửi.
CREATE INDEX ix_outbox_due ON notification_outbox (next_attempt_at, id)
  WHERE status = 'PENDING';
CREATE INDEX ix_outbox_member ON notification_outbox (tenant_id, member_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Chiến dịch chăm sóc.
-- ---------------------------------------------------------------------------

CREATE TABLE campaign (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  code          text NOT NULL,
  name          text NOT NULL,
  trigger_type  text NOT NULL CHECK (trigger_type IN (
                  'LOW_SESSION_BALANCE',   -- còn <= N buổi
                  'PACKAGE_EXPIRING',      -- hết hạn trong <= N ngày
                  'INACTIVE_MEMBER',       -- không tập >= N ngày
                  'BIRTHDAY',
                  'PAYMENT_DUE')),
  threshold     int NOT NULL CHECK (threshold >= 0),   -- N của điều kiện trên
  channel       text NOT NULL CHECK (channel IN ('ZALO_ZNS','ZALO_OA','SMS','EMAIL','INAPP')),
  template_code text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  -- Khoảng cách tối thiểu giữa hai lần gửi lại cho cùng một hội viên (ngày).
  -- 0 = chỉ gửi đúng một lần cho mỗi gói, mãi mãi.
  cooldown_days int NOT NULL DEFAULT 0 CHECK (cooldown_days >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_campaign_anchor UNIQUE (tenant_id, id),
  CONSTRAINT uq_campaign_code   UNIQUE (tenant_id, code)
);
CREATE TRIGGER trg_campaign_updated BEFORE UPDATE ON campaign
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cron quét hằng ngày, nhưng mỗi (chiến dịch, gói) chỉ bắn MỘT lần.
-- Thiếu bảng này thì hội viên nhận cùng một tin mỗi sáng cho tới khi hết gói.
CREATE TABLE campaign_enrollment (
  campaign_id       uuid NOT NULL,
  member_package_id uuid NOT NULL,
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  triggered_at      timestamptz NOT NULL DEFAULT now(),
  outbox_id         bigint REFERENCES notification_outbox(id),
  PRIMARY KEY (campaign_id, member_package_id),
  CONSTRAINT fk_enroll_campaign FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES campaign (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_enroll_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_enroll_time ON campaign_enrollment (tenant_id, triggered_at DESC);

-- Đếm tin đã gửi trong tháng để chặn theo hạn mức của gói SaaS.
-- Cột đếm riêng thay vì COUNT(*) trên outbox: outbox sẽ được dọn định kỳ.
CREATE TABLE tenant_message_usage (
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  channel      text NOT NULL,
  sent_count   int  NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
  PRIMARY KEY (tenant_id, period_month, channel)
);
