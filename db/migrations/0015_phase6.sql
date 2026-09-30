-- =============================================================================
-- 0015 — Phase 6: worker gửi tin, Zalo OA theo từng phòng, chiến dịch chăm sóc.
--
-- Bảng đã có từ 0004. Migration này thêm ĐƯỜNG ĐI cho worker — tiến trình chạy
-- nền không có request nào, nên không có tenant nào trong ngữ cảnh — và nới /
-- siết đúng những chỗ mà luồng thật cần.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Hàng đợi CHÍNH LÀ bảng outbox.
--
-- Không thêm BullMQ cho việc gửi tin: outbox đã bền (nằm trong CSDL), đã được
-- ghi cùng transaction nghiệp vụ, và `FOR UPDATE SKIP LOCKED` cho nhiều worker
-- cùng lấy việc mà không dẫm lên nhau. Thêm một hàng đợi thứ hai là thêm một
-- chỗ hai nguồn sự thật lệch nhau.
--
-- LEASE thay vì khoá dài: lấy việc thì đặt SENDING và đẩy next_attempt_at ra
-- tương lai. Worker chết giữa chừng thì hết lease dòng đó tự quay lại hàng —
-- không cần ai dọn tay. `attempts` tăng ngay lúc lấy, nên một tin làm worker
-- chết liên tục cũng dừng sau số lần tối đa thay vì lặp vô hạn.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS ix_outbox_due;
CREATE INDEX ix_outbox_queue ON notification_outbox (next_attempt_at, id)
  WHERE status IN ('PENDING', 'SENDING');

-- Cửa hẹp xuyên tenant thứ nhất: chỉ trả (id, tenant_id), không trả nội dung.
-- Worker đọc nội dung SAU ĐÓ, bằng TenantDb.runAs — tức vẫn qua RLS.
CREATE OR REPLACE FUNCTION outbox_claim_due(p_limit int, p_lease_seconds int)
RETURNS TABLE (id bigint, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH due AS (
    SELECT o.id
    FROM notification_outbox o
    JOIN tenant t ON t.id = o.tenant_id
    WHERE o.status IN ('PENDING', 'SENDING')
      AND o.next_attempt_at <= now()
      -- Phòng bị khoá / đã đóng thì không gửi tin nhân danh họ nữa.
      AND t.status IN ('TRIAL', 'ACTIVE', 'PAST_DUE')
    ORDER BY o.next_attempt_at, o.id
    LIMIT least(greatest(p_limit, 1), 200)
    FOR UPDATE OF o SKIP LOCKED
  )
  UPDATE notification_outbox o
     SET status = 'SENDING',
         attempts = o.attempts + 1,
         next_attempt_at = now() + make_interval(secs => least(greatest(p_lease_seconds, 30), 3600))
    FROM due
   WHERE o.id = due.id
  RETURNING o.id, o.tenant_id;
$fn$;

REVOKE ALL ON FUNCTION outbox_claim_due(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION outbox_claim_due(int, int) TO app_rw;

-- Cửa hẹp thứ hai: danh sách phòng đang hoạt động, để job định kỳ (chiến dịch,
-- làm mới token, dọn tệp) lặp qua từng phòng. Mỗi phòng sau đó chạy bằng
-- runAs(tenantId) — RLS vẫn là thứ quyết định thấy gì.
CREATE OR REPLACE FUNCTION worker_tenant_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT id FROM tenant WHERE status IN ('TRIAL', 'ACTIVE', 'PAST_DUE') ORDER BY id;
$fn$;

REVOKE ALL ON FUNCTION worker_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION worker_tenant_ids() TO app_rw;

-- ---------------------------------------------------------------------------
-- 2. Kết nối OA đi theo HAI bước: lưu app_id + secret trước, sau khi chủ phòng
--    bấm đồng ý trên Zalo mới biết oa_id. Nên oa_id được phép NULL — nhưng
--    trạng thái CONNECTED thì bắt buộc có đủ.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_zalo_oa ALTER COLUMN oa_id DROP NOT NULL;
ALTER TABLE tenant_zalo_oa ADD CONSTRAINT zalo_connected_complete CHECK (
  status <> 'CONNECTED'
  OR (oa_id IS NOT NULL AND access_token_enc IS NOT NULL
      AND refresh_token_enc IS NOT NULL AND token_expires_at IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- 3. OTP đi qua outbox.
--
-- Luồng OTP chạy TRƯỚC khi có tenant, bằng app_auth. Nó cần biết người này là
-- khách của phòng nào có OA đang kết nối, rồi xếp tin vào outbox của phòng đó.
--
-- Cấp theo CỘT như 0006: app_auth có BYPASSRLS, nên `GRANT SELECT ON
-- tenant_zalo_oa` là cho nó đọc secret_enc và token của MỌI phòng. Hai cột
-- trạng thái là đủ để chọn phòng, không hơn.
-- ---------------------------------------------------------------------------
GRANT SELECT (tenant_id, status)                ON tenant_zalo_oa      TO app_auth;
GRANT SELECT (tenant_id, template_code, status) ON tenant_zns_template TO app_auth;
-- Chỉ INSERT: app_auth không đọc lại được hộp thư đi của phòng nào.
GRANT INSERT ON notification_outbox TO app_auth;
