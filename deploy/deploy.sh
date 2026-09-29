#!/usr/bin/env bash
# Chạy TRÊN MÁY CHỦ, trong ~/gym. GitHub Actions gọi qua SSH sau khi đã chép
# thư mục deploy/ lên; chạy tay cũng được:
#
#   IMAGE_TAG=<sha> ./deploy.sh              # token GHCR đọc từ stdin (nếu có)
#   IMAGE_TAG=<sha-cũ> ./deploy.sh </dev/null  # quay về bản cũ còn trong máy
#
# Biến vào: IMAGE_TAG (bắt buộc), IMAGE_PREFIX, DOMAIN, GHCR_USER, SEED=1.
# Token GHCR đi qua STDIN, không qua tham số: tham số lệnh hiện trong `ps`.
set -euo pipefail
cd "$(dirname "$0")"

: "${IMAGE_TAG:?Thiếu IMAGE_TAG}"
NEW_TAG="$IMAGE_TAG"
NEW_PREFIX="${IMAGE_PREFIX:-}"
NEW_DOMAIN="${DOMAIN:-}"
# Compose ưu tiên biến môi trường hơn .env. Gỡ ra để .env là nguồn DUY NHẤT —
# không thì nhánh quay về bản cũ bên dưới vẫn chạy tag mới.
unset IMAGE_TAG IMAGE_PREFIX DOMAIN

log() { printf '\n==> %s\n' "$*"; }

# ---- 1. Bí mật: sinh MỘT LẦN, không bao giờ ghi đè ---------------------------
# Hex cho mọi thứ nằm trong URL kết nối (không có ký tự phải escape) và để
# không bao giờ chứa chuỗi mẫu mà config-guard của API từ chối.
if [[ ! -f .env ]]; then
  log "Tạo .env với bí mật ngẫu nhiên (lần đầu)"
  umask 077
  cat > .env <<EOF
# Sinh tự động bởi deploy.sh lúc $(date -Iseconds). KHÔNG commit, KHÔNG xoá:
# mất tệp này là mất mật khẩu của volume Postgres đang chạy.
DB_PASSWORD=$(openssl rand -hex 24)
APP_DB_PASSWORD=$(openssl rand -hex 24)
REDIS_PASSWORD=$(openssl rand -hex 24)
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
TENANT_SECRET_KEY=$(openssl rand -base64 32)

# S3 bên ngoài — ĐIỀN TAY rồi chạy lại deploy.
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_FORCE_PATH_STYLE=true
EOF
fi
chmod 600 .env

# S3 là dịch vụ ngoài, không sinh được: thiếu thì dừng TRƯỚC khi đụng vào gì.
for k in S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY; do
  if ! grep -qE "^${k}=.+" .env; then
    echo "::error::Chưa điền ${k} trong $PWD/.env" >&2
    exit 1
  fi
done

# Ghi/cập nhật một khoá không bí mật trong .env.
upsert() {
  local key="$1" val="$2"
  [[ -z "$val" ]] && return 0
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

PREV_TAG="$(sed -n 's/^IMAGE_TAG=//p' .env)"
upsert IMAGE_PREFIX "$NEW_PREFIX"
upsert DOMAIN "$NEW_DOMAIN"
upsert IMAGE_TAG "$NEW_TAG"

compose() { docker compose -f docker-compose.prod.yml "$@"; }

# ---- 2. Kéo image -------------------------------------------------------------
# DOCKER_CONFIG riêng: `docker login` mặc định ghi đè thông tin đăng nhập ghcr.io
# chung của máy, mà máy này còn nhiều dự án khác kéo image từ ghcr.io.
export DOCKER_CONFIG="$PWD/.docker"
mkdir -p "$DOCKER_CONFIG"
GHCR_TOKEN=""
if [[ ! -t 0 ]]; then read -r GHCR_TOKEN || true; fi
if [[ -n "$GHCR_TOKEN" ]]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-github}" --password-stdin >/dev/null
  trap 'docker logout ghcr.io >/dev/null 2>&1 || true' EXIT
fi

log "Kéo image ${NEW_TAG}"
compose --profile tools pull --quiet

# ---- 3. Hạ tầng ---------------------------------------------------------------
log "Khởi động postgres, redis"
compose up -d --wait postgres redis

# ---- 4. Migration (chỉ tiến; runner tự khoá advisory lock + kiểm checksum) ----
log "Chạy migration"
compose run --rm migrate

# ---- 5. Ứng dụng --------------------------------------------------------------
log "Khởi động api + web"
if ! compose up -d --wait --wait-timeout 180 api web; then
  echo "::error::api/web không healthy. Log gần nhất:" >&2
  compose logs --tail 80 api web >&2 || true
  if [[ -n "$PREV_TAG" && "$PREV_TAG" != "$NEW_TAG" ]]; then
    log "Quay về ${PREV_TAG} (migration KHÔNG được hoàn tác — chỉ tiến)"
    upsert IMAGE_TAG "$PREV_TAG"
    compose up -d --wait --wait-timeout 180 api web || true
  fi
  exit 1
fi

if [[ "${SEED:-0}" == "1" ]]; then
  log "Nạp dữ liệu mẫu (seed)"
  compose run --rm seed || echo "::warning::seed lỗi — có thể đã nạp từ trước"
fi

# ---- 6. Kiểm tra qua cổng mà nginx dùng --------------------------------------
log "Kiểm tra sức khoẻ"
curl -fsS "http://127.0.0.1:${API_HOST_PORT:-4210}/api/health"; echo
curl -fsS -o /dev/null -w 'web /login -> %{http_code}\n' "http://127.0.0.1:${WEB_HOST_PORT:-3210}/login"

# ---- 7. Dọn image cũ của dự án này (giữ bản hiện tại + bản trước) ------------
prefix="$(sed -n 's/^IMAGE_PREFIX=//p' .env)"
if [[ -n "$prefix" ]]; then
  docker images --format '{{.Repository}}:{{.Tag}}' \
    | grep -E "^${prefix}-(api|web|tools):" \
    | grep -v -E ":(${NEW_TAG}|${PREV_TAG:-none})$" \
    | xargs -r docker rmi >/dev/null 2>&1 || true
fi

log "Deploy ${NEW_TAG} xong — https://$(sed -n 's/^DOMAIN=//p' .env)"
