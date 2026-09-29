-- =============================================================================
-- 0006 — app_auth cần biết identity này là hội viên / PT nào tại phòng được
--        chọn, để nhét memberId/trainerId vào access token.
--
-- Cấp theo CỘT chứ không theo bảng: app_auth có BYPASSRLS, nên `GRANT SELECT ON
-- member` sẽ cho nó đọc tên, ghi chú, số đo của toàn bộ hội viên mọi phòng.
-- Ba cột dưới đây là đúng những gì luồng đăng nhập cần, không hơn.
--
-- Đây cũng là ví dụ mẫu cho mọi migration về sau: bảng mới có tenant_id thì
-- PHẢI gọi `SELECT enable_tenant_rls('<bảng>');` — cổng gác
-- test/tenant-isolation.spec.ts đỏ nếu quên.
-- =============================================================================

GRANT SELECT (id, tenant_id, identity_id) ON member  TO app_auth;
GRANT SELECT (id, tenant_id, identity_id) ON trainer TO app_auth;
