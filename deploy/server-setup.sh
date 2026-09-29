#!/usr/bin/env bash
# Cài đặt MỘT LẦN trên máy chủ (cần sudo): site nginx + chứng chỉ Let's Encrypt.
# CI không chạy script này — nginx của máy dùng chung cho nhiều dự án, nên chỉ
# đụng tới nó khi có người chủ động chạy.
#
#   DOMAIN=gym.51-79-255-102.sslip.io ./server-setup.sh
#
# HTTPS là BẮT BUỘC, không phải tuỳ chọn: ở production cookie phiên đặt cờ
# `secure`, trình duyệt sẽ không lưu nó qua http:// và không ai đăng nhập được.
set -euo pipefail
cd "$(dirname "$0")"

: "${DOMAIN:?Thiếu DOMAIN, vd: DOMAIN=gym.51-79-255-102.sslip.io}"
SITE="/etc/nginx/sites-available/${DOMAIN}.conf"

if [[ -f "$SITE" ]]; then
  echo "Đã có $SITE — giữ nguyên (certbot đã sửa tệp này). Xoá tay nếu muốn cài lại."
else
  sed "s/__DOMAIN__/${DOMAIN}/g" nginx/gym.conf | sudo tee "$SITE" >/dev/null
  sudo ln -sf "$SITE" "/etc/nginx/sites-enabled/${DOMAIN}.conf"
fi

# nginx -t TRƯỚC khi reload: một cấu hình hỏng là sập mọi site trên máy.
sudo nginx -t
sudo systemctl reload nginx

if sudo test -d "/etc/letsencrypt/live/${DOMAIN}"; then
  echo "Chứng chỉ cho ${DOMAIN} đã có."
else
  email_args=(--register-unsafely-without-email)
  [[ -n "${CERTBOT_EMAIL:-}" ]] && email_args=(-m "$CERTBOT_EMAIL")
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --redirect "${email_args[@]}"
fi

echo "Xong: https://${DOMAIN}"
