#!/bin/bash
# Chạy MỘT LẦN lúc khởi tạo volume postgres (docker-entrypoint-initdb.d), và
# được CI gọi lại trên máy chủ Postgres của nó.
#
# Ba role, ba mức quyền. Tách ra là điều kiện để RLS có ý nghĩa:
#
#   pt_migrator  : chủ sở hữu schema, chạy migration. App KHÔNG dùng.
#   app_rw       : role của API. NOSUPERUSER + NOBYPASSRLS -> RLS áp thật.
#   app_auth     : chỉ luồng đăng nhập, chạy TRƯỚC khi có tenant context.
#                  BYPASSRLS nhưng quyền hẹp (xem 0005_rls.sql).
#   app_platform : quản trị nền tảng, nhìn xuyên tenant. Mọi thao tác ghi audit.
#
# CẢNH BÁO: app_rw tuyệt đối không được SUPERUSER hay BYPASSRLS. Superuser bỏ
# qua RLS kể cả khi bảng đã FORCE ROW LEVEL SECURITY.
#
# Mật khẩu đến từ biến môi trường, KHÔNG ghi cứng trong mã nguồn: repo này công
# khai, và một mật khẩu nằm sẵn trong lịch sử git thì không gỡ ra được nữa.
set -euo pipefail

: "${APP_DB_PASSWORD:?Thiếu APP_DB_PASSWORD — xem .env.example}"

# Mật khẩu có dấu nháy đơn sẽ phá câu lệnh. Chặn sớm cho rõ lý do.
case "$APP_DB_PASSWORD" in
  *\'*) echo "APP_DB_PASSWORD không được chứa dấu nháy đơn" >&2; exit 1 ;;
esac

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${POSTGRES_DB:-postgres}" <<EOSQL
DO \$do\$
DECLARE
  pw text := '${APP_DB_PASSWORD}';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    EXECUTE format(
      'CREATE ROLE app_rw LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE', pw);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auth') THEN
    EXECUTE format(
      'CREATE ROLE app_auth LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE', pw);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_platform') THEN
    EXECUTE format(
      'CREATE ROLE app_platform LOGIN PASSWORD %L NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE', pw);
  END IF;
END
\$do\$;

GRANT CONNECT ON DATABASE ${POSTGRES_DB:-postgres} TO app_rw, app_auth, app_platform;
GRANT USAGE ON SCHEMA public TO app_rw, app_auth, app_platform;
EOSQL

echo "Đã tạo ba role ứng dụng."
