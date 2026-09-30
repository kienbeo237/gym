-- =============================================================================
-- 0020 — Báo phát ZNS (webhook của Zalo) và SMS dự phòng cho OTP.
--
-- `SENT` chỉ nghĩa là Zalo ĐÃ NHẬN yêu cầu gửi. Hội viên đã nhận tin hay chưa
-- là sự kiện riêng, tới sau qua webhook `user_received_message`. Ghi nó vào
-- CỘT RIÊNG chứ không thêm trạng thái `DELIVERED`: mọi truy vấn đang đếm `SENT`
-- (hạn mức, thống kê, đối soát) giữ nguyên nghĩa, và báo phát tới trước khi
-- worker kịp ghi `SENT` (Zalo nhanh hơn pha 3) cũng không làm lùi trạng thái.
-- =============================================================================

ALTER TABLE notification_outbox ADD COLUMN delivered_at timestamptz;

-- Webhook khớp tin theo mã Zalo cấp khi không có tracking_id.
CREATE INDEX ix_outbox_provider_msg ON notification_outbox (tenant_id, provider_msg_id)
  WHERE provider_msg_id IS NOT NULL;

-- "OA Secret Key" ở mục Webhook của ứng dụng Zalo — KHÁC secret của ứng dụng
-- dùng cho OAuth. Dùng để kiểm chữ ký X-ZEvent-Signature. Niêm phong như mọi
-- bí mật khác; không cấp cho app_auth (0015 đã cấp theo CỘT, cột mới không tự
-- lọt vào).
ALTER TABLE tenant_zalo_oa ADD COLUMN webhook_secret_enc bytea;
