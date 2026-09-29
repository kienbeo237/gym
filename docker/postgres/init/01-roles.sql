-- Chạy MỘT LẦN lúc khởi tạo volume postgres (docker-entrypoint-initdb.d).
-- Ba role, ba mức quyền. Tách ra là điều kiện để RLS có ý nghĩa.
--
--   pt_migrator  : chủ sở hữu schema, chạy migration. App KHÔNG dùng.
--   app_rw       : role của API. NOSUPERUSER + NOBYPASSRLS -> RLS áp thật.
--   app_auth     : chỉ luồng đăng nhập, chạy TRƯỚC khi có tenant context.
--                  BYPASSRLS nhưng quyền hẹp (xem 0005_rls.sql).
--   app_platform : quản trị nền tảng, nhìn xuyên tenant. Mọi thao tác phải ghi audit.
--
-- CẢNH BÁO: app_rw tuyệt đối không được SUPERUSER hay BYPASSRLS.
-- Superuser bỏ qua RLS kể cả khi bảng đã FORCE ROW LEVEL SECURITY.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    CREATE ROLE app_rw LOGIN PASSWORD 'pt_dev_pw' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    CREATE ROLE app_auth LOGIN PASSWORD 'pt_dev_pw' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    CREATE ROLE app_platform LOGIN PASSWORD 'pt_dev_pw' NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE pt TO app_rw, app_auth, app_platform;
GRANT USAGE ON SCHEMA public TO app_rw, app_auth, app_platform;
