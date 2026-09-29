# Deploy production

```
push main ──> CI (test + build) ──xanh──> Deploy
                                           ├─ build 3 image  -> ghcr.io/<owner>/gym-{api,web,tools}:<sha>
                                           └─ SSH vào máy chủ -> ~/gym/deploy.sh
                                                ├─ sinh .env bí mật (chỉ lần đầu)
                                                ├─ pull image, bật postgres/redis
                                                ├─ migrate (chỉ tiến)
                                                ├─ bật api + web, chờ healthy (hỏng -> quay về tag cũ)
                                                └─ dọn image cũ
```

Trên máy chủ, nginx của host đứng trước (HTTPS bằng certbot) và chuyển:

| Đường dẫn        | Đích                       | Cổng host (127.0.0.1) |
|------------------|----------------------------|-----------------------|
| `/api/session`, `/api/proxy/*` | Next (route handler) | 3210           |
| `/api/*`         | NestJS                     | 4210                  |
| `/*`             | Next                       | 3210                  |

Tệp (ảnh, hợp đồng, hoá đơn PDF) lưu ở **S3 CMC Cloud**; trình duyệt tải
lên/xuống thẳng qua URL ký sẵn, không đi qua máy chủ này.

## Cấu hình một lần

### 0. `~/gym/.env` trên máy chủ

Bí mật nội bộ (mật khẩu DB, Redis, JWT) do `deploy.sh` tự sinh nếu tệp chưa có.
Cấu hình S3 phải điền tay — thiếu thì deploy dừng ngay với thông báo rõ:

```
S3_ENDPOINT=https://s3.hn-2.cloud.cmctelecom.vn
S3_REGION=hn-2
S3_BUCKET=<bucket>
S3_ACCESS_KEY=<access key id>
S3_SECRET_KEY=<secret access key>
S3_FORCE_PATH_STYLE=true
```

Bucket phải bật **CORS** cho `https://<DEPLOY_DOMAIN>` (method `PUT`, `GET`,
header `content-type`) — trình duyệt PUT thẳng lên S3, thiếu CORS là mọi lần
tải ảnh đều hỏng.

### 1. Khoá SSH riêng cho deploy

Không dùng khoá cá nhân. Sinh khoá mới, đưa khoá công khai lên máy chủ:

```bash
ssh-keygen -t ed25519 -N "" -C "github-deploy-gym" -f gym_deploy
ssh-copy-id -i gym_deploy.pub ubuntu@51.79.255.102   # hoặc nối tay vào ~/.ssh/authorized_keys
ssh-keyscan -t ed25519 51.79.255.102                  # -> DEPLOY_KNOWN_HOSTS
```

### 2. GitHub → Settings → Secrets and variables → Actions

| Loại     | Tên                  | Giá trị                                   |
|----------|----------------------|-------------------------------------------|
| Secret   | `DEPLOY_HOST`        | `51.79.255.102`                           |
| Secret   | `DEPLOY_USER`        | `ubuntu`                                  |
| Secret   | `DEPLOY_SSH_KEY`     | nội dung tệp `gym_deploy` (khoá riêng)    |
| Secret   | `DEPLOY_KNOWN_HOSTS` | dòng in ra từ `ssh-keyscan` ở trên        |
| Variable | `DEPLOY_DOMAIN`      | vd `gym.51-79-255-102.sslip.io`           |
| Variable | `DEPLOY_PATH`        | (tuỳ chọn) thư mục trên máy chủ, mặc định `gym` |

`sslip.io` phân giải mọi tên chứa IP về chính IP đó, nên dùng được ngay khi
chưa có tên miền thật. Có tên miền riêng thì trỏ bản ghi A về máy chủ rồi đổi
`DEPLOY_DOMAIN`.

### 3. nginx + HTTPS trên máy chủ

HTTPS **bắt buộc**: cookie phiên có cờ `secure` ở production, qua `http://` thì
trình duyệt không lưu và không ai đăng nhập được.

```bash
scp -r deploy ubuntu@51.79.255.102:~/gym-setup
ssh ubuntu@51.79.255.102 'DOMAIN=gym.51-79-255-102.sslip.io ~/gym-setup/server-setup.sh'
```

### 4. Deploy lần đầu

Push lên `main`, hoặc Actions → **Deploy** → *Run workflow*. Muốn có dữ liệu
demo thì tick **seed** (tạo 2 phòng tập với mật khẩu công khai `Matkhau@123` —
đừng tick trên hệ thống có khách thật).

## Vận hành

```bash
cd ~/gym
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
IMAGE_TAG=<sha-cũ> ./deploy.sh </dev/null      # quay về bản cũ còn trong máy
```

- **`~/gym/.env` là bí mật duy nhất và không có bản sao nào khác.** Mất nó là mất
  mật khẩu của volume Postgres. Sao lưu nó cùng dữ liệu.
- Migration chỉ tiến. Quay về image cũ không hoàn tác schema — mã cũ phải chịu
  được schema mới.
- `pt_migrator` vẫn là SUPERUSER như ở dev (xem mục hạn chế trong README gốc).
- Chưa có sao lưu tự động cho volume `gym-pt_pgdata`.
