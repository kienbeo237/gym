-- =============================================================================
-- 0005 — Row Level Security: cách ly tenant ở tầng DB.
--
-- Vì sao ở DB chứ không ở service: một câu `WHERE tenant_id = ?` bị quên trong
-- 1 trong 300 query là rò dữ liệu giữa hai phòng gym cạnh tranh nhau, và không
-- có test nào bắt được cái bị quên. RLS đảo ngược mặc định: quên là ra 0 dòng.
--
-- NĂM ĐIỀU KIỆN, THIẾU MỘT LÀ RLS VÔ HIỆU MÀ KHÔNG BÁO GÌ:
--   1. FORCE ROW LEVEL SECURITY  — ENABLE không áp cho CHỦ SỞ HỮU bảng, mà app
--      thường kết nối đúng bằng user đã tạo bảng.
--   2. Role của app không được SUPERUSER (superuser bỏ qua cả FORCE) và không
--      được BYPASSRLS.
--   3. `SET LOCAL` / set_config(..., TRUE) — KHÔNG dùng `SET`. Pool tái sử dụng
--      kết nối, `SET` sống hết đời kết nối và rò sang request của tenant khác.
--   4. current_setting('app.tenant_id', TRUE) — tham số thứ hai bắt buộc, thiếu
--      nó thì biến chưa đặt sẽ NÉM LỖI thay vì trả NULL.
--   5. Mọi UNIQUE index phải có tenant_id (đã làm ở 0002/0003/0004).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Hàm dùng chung. Migration mới tạo bảng có tenant_id PHẢI gọi hàm này.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enable_tenant_rls(p_table text) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', p_table);
  EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', p_table);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', p_table);
  EXECUTE format($pol$
    CREATE POLICY tenant_isolation ON %I
      USING      (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
      WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  $pol$, p_table);
END $fn$;

-- ---------------------------------------------------------------------------
-- Áp cho MỌI bảng có cột tenant_id.
-- Vòng lặp này phủ toàn bộ bảng hiện có; bảng TƯƠNG LAI do
-- `tenant-isolation.spec.ts` gác — nó đỏ nếu có bảng mang tenant_id mà thiếu RLS.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attname = 'tenant_id'
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY 1
  LOOP
    PERFORM enable_tenant_rls(t);
    RAISE NOTICE 'RLS: %', t;
  END LOOP;
END $do$;

-- ---------------------------------------------------------------------------
-- Hai bảng toàn cục có chính sách RIÊNG (không có cột tenant_id).
-- ---------------------------------------------------------------------------

-- `tenant`: mỗi phòng chỉ thấy chính mình. Cột là `id`, không phải `tenant_id`,
-- nên không lọt vào vòng lặp trên.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant
  USING      (id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid);

-- `identity` là toàn cục nhưng KHÔNG được để app_rw đọc tự do: nếu không, một
-- query quên join vẫn liệt kê được số điện thoại của khách hàng phòng khác.
-- Chỉ thấy định danh có vai trò tại tenant đang mở.
ALTER TABLE identity ENABLE ROW LEVEL SECURITY;
ALTER TABLE identity FORCE  ROW LEVEL SECURITY;

CREATE POLICY identity_read ON identity FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM tenant_user tu
    WHERE tu.identity_id = identity.id
      AND tu.tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid
  ));

-- Tạo hội viên mới: identity chưa có tenant_user nên policy đọc chưa khớp.
-- HỆ QUẢ BẮT BUỘC: app phải tự sinh uuid rồi INSERT **không RETURNING**, vì
-- RETURNING bị policy SELECT ở trên chặn. Xem IdentityRepository.create.
CREATE POLICY identity_insert ON identity FOR INSERT WITH CHECK (true);

CREATE POLICY identity_update ON identity FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM tenant_user tu
    WHERE tu.identity_id = identity.id
      AND tu.tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid
  ));

-- =============================================================================
-- PHÂN QUYỀN THEO ROLE
-- =============================================================================

-- ---- app_rw: role của API. Bị RLS áp. ---------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_rw;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_rw;

-- Thu lại những bảng thuộc mặt phẳng xác thực / nền tảng. API không có việc gì
-- ở đây, và đây là các bảng KHÔNG có RLS nên quyền thừa là quyền rò.
REVOKE ALL ON otp_challenge, refresh_token, identity_phone_history,
              platform_admin, platform_audit_log FROM app_rw;
-- Bảng gói SaaS: chỉ đọc.
REVOKE INSERT, UPDATE, DELETE ON plan, tenant_subscription, tenant_billing_record FROM app_rw;
GRANT  SELECT                 ON plan, tenant_subscription, tenant_billing_record TO   app_rw;
-- `tenant`: sửa được hồ sơ phòng mình (RLS chặn phòng khác), không tự xoá.
REVOKE INSERT, DELETE ON tenant FROM app_rw;

-- ---- app_auth: luồng đăng nhập, chạy TRƯỚC khi có tenant context ------------
-- BYPASSRLS nhưng quyền hẹp: chỉ đủ để xác thực rồi phát token.
GRANT SELECT                 ON tenant, tenant_user, platform_admin TO app_auth;
GRANT SELECT, INSERT, UPDATE ON identity, otp_challenge, refresh_token TO app_auth;
GRANT INSERT                 ON identity_phone_history TO app_auth;
GRANT USAGE, SELECT          ON ALL SEQUENCES IN SCHEMA public TO app_auth;

-- ---- app_platform: quản trị nền tảng, nhìn xuyên tenant ---------------------
-- Mọi thao tác qua role này PHẢI ghi platform_audit_log, kể cả thao tác đọc.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO app_platform;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO app_platform;

-- ---- Bảng tạo về sau cũng tự có quyền --------------------------------------
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw, app_platform;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw, app_auth, app_platform;

-- ---------------------------------------------------------------------------
-- Tra cứu nhanh khi nghi ngờ cách ly hỏng:
--
--   SELECT relname, relrowsecurity, relforcerowsecurity
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname='public' AND c.relkind='r' ORDER BY 1;
--
--   SELECT rolname, rolsuper, rolbypassrls FROM pg_roles
--   WHERE rolname IN ('app_rw','app_auth','app_platform','pt_migrator');
--
-- app_rw mà có rolsuper hoặc rolbypassrls = true thì toàn bộ file này vô nghĩa.
-- ---------------------------------------------------------------------------
