-- 0024: THÔNG BÁO TRONG ỨNG DỤNG cho nhân viên (chuông ở góc màn hình).
--
-- Worker sinh thông báo mỗi 5 phút (StaffReminderService):
--   PT_UPCOMING  HLV: còn ~30 phút nữa tới buổi dạy
--   PT_AGENDA    HLV: lịch dạy hôm nay, gửi từ 7h sáng
--   UNCHECKED    Lễ tân (không có lễ tân thì chủ phòng) + HLV: buổi đã bắt
--                đầu quá 10 phút mà chưa điểm danh
--
-- Idempotent bằng dedupe_key + UNIQUE: job chạy lặp, chạy hai bản worker cùng
-- lúc, hay chạy lại sau khi sập đều không sinh thông báo trùng — INSERT ...
-- ON CONFLICT DO NOTHING là toàn bộ cơ chế, không cần khoá.
--
-- Đây KHÔNG phải notification_outbox: outbox là tin gửi RA NGOÀI (Zalo/SMS) cho
-- hội viên, có hàng đợi, thử lại, tính phí. Thông báo ở đây chỉ nằm trong app.

CREATE TABLE staff_notification (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  identity_id uuid NOT NULL REFERENCES identity(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('PT_UPCOMING', 'PT_AGENDA', 'UNCHECKED')),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body        text NOT NULL CHECK (length(body) <= 2000),
  link        text CHECK (link IS NULL OR link LIKE '/%'),
  booking_id  uuid REFERENCES booking(id) ON DELETE CASCADE,
  dedupe_key  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz,
  CONSTRAINT uq_staff_notification_dedupe UNIQUE (tenant_id, dedupe_key)
);

-- Chuông hỏi "20 thông báo mới nhất + số chưa đọc của TÔI" mỗi phút.
CREATE INDEX ix_staff_notification_inbox ON staff_notification (tenant_id, identity_id, created_at DESC);
CREATE INDEX ix_staff_notification_unread ON staff_notification (tenant_id, identity_id) WHERE read_at IS NULL;

COMMENT ON TABLE staff_notification IS
  'Thông báo trong app cho nhân viên (nhắc lịch dạy, buổi quá giờ chưa điểm danh). Sinh bởi worker, idempotent theo dedupe_key.';

SELECT enable_tenant_rls('staff_notification');

-- Nội dung thông báo không ai sửa; chỉ được đánh dấu đã đọc.
REVOKE UPDATE ON staff_notification FROM app_rw;
GRANT UPDATE (read_at) ON staff_notification TO app_rw;
