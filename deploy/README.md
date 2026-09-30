# Deploy production

```
push main ──> CI (test + build) ──xanh──> Deploy
                                           ├─ build 3 image  -> ghcr.io/<owner>/gym-{api,web,tools}:<sha>
                                           └─ SSH vào máy chủ -> ~/gym/deploy.sh
                                                ├─ sinh .env bí mật (chỉ lần đầu)
                                                ├─ pull image, bật postgres/redis
                                                ├─ migrate (chỉ tiến)
                                                ├─ bật api + worker + web, chờ healthy (hỏng -> quay về tag cũ)
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

`worker` chạy cùng image với `api` (`node dist/worker.js`), không mở cổng: gửi
tin Zalo từ hộp thư đi, chạy chiến dịch chăm sóc, làm mới token OA, làm tươi báo
cáo và dọn tệp mồ côi. Nó gọi ra ngoài tới `oauth.zaloapp.com` và
`business.openapi.zalo.me` — tường lửa phải cho phép HTTPS đi ra.

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

S3 của CMC (Ceph) chỉ áp **rule đầu tiên khớp origin**, không xét tiếp các
rule sau. Rule riêng (ID `gym-pt`) phải đứng TRƯỚC rule `*` sẵn có của bucket,
không thì rule `*` nuốt origin này và method nó không liệt kê (GET) bị 403.
`PutBucketCors` ghi đè toàn bộ cấu hình: luôn đọc rule hiện có rồi gộp vào.

Sao lưu tự động (mục **Sao lưu** bên dưới) mặc định dùng chính bucket/khoá này
với prefix `backups/pt/`. Nên cho nó bucket + khoá **riêng** (khoá của API bị lộ
thì kẻ tấn công không xoá được luôn bản sao lưu) — điền thêm, tuỳ chọn:

```
BACKUP_S3_BUCKET=<bucket sao lưu>
BACKUP_S3_ACCESS_KEY=<khoá chỉ có quyền trên bucket đó>
BACKUP_S3_SECRET_KEY=<...>
# BACKUP_S3_ENDPOINT / BACKUP_S3_REGION: bỏ trống = giống S3_*
BACKUP_ALERT_WEBHOOK=<URL webhook Slack/Discord/Google Chat — báo khi sao lưu lỗi>
BACKUP_HEARTBEAT_URL=<URL ping healthchecks.io (chu kỳ 1 ngày, ân hạn 2 giờ) — báo khi IM LẶNG>
```

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

### 3b. Quản trị nền tảng và tài khoản nhận tiền

Thêm vào `~/gym/.env` (không bắt buộc, nhưng thiếu thì chủ phòng không thấy số
tài khoản để chuyển tiền):

```
SAAS_BANK_NAME=<tên ngân hàng>
SAAS_BANK_ACCOUNT=<số tài khoản>
SAAS_BANK_HOLDER=<tên chủ tài khoản>
SAAS_SUPPORT_CONTACT=<VD: Zalo 09xx xxx xxx>
```

Người quản trị **Toàn quyền (SUPER) đầu tiên** tạo tay bằng SQL, một lần —
không qua seed. Từ người thứ hai trở đi thì cấp ở giao diện: **/platform →
Quản trị viên** (chỉ SUPER thấy), xem bên dưới. Người đó phải có mật khẩu:
đăng nhập nền tảng CHỈ nhận mật khẩu, không nhận OTP. Băm bằng `pgcrypto`
(bcrypt, API đọc được) nên không cần công cụ nào ngoài psql:

```bash
cd ~/gym
docker compose -f docker-compose.prod.yml exec postgres psql -U pt_migrator -d pt
```

```sql
-- 1) số điện thoại chưa có tài khoản: tạo kèm mật khẩu tạm
--    must_change_password = true: lần đăng nhập đầu bắt đặt mật khẩu mới,
--    nên mật khẩu tạm lọt ra (lịch sử shell, tin nhắn) cũng hết giá trị.
INSERT INTO identity (phone, full_name, password_hash, phone_verified_at, must_change_password)
VALUES ('+849xxxxxxxx', 'Họ tên', crypt('<mật khẩu tạm>', gen_salt('bf', 10)), now(), true)
ON CONFLICT (phone) DO NOTHING;
-- (đã có tài khoản nhưng chưa có mật khẩu thì UPDATE password_hash tương tự)

-- 2) cấp quyền: SUPPORT (chỉ xem) | OPS (thu tiền, khoá/mở phòng) | SUPER (+ đóng phòng)
INSERT INTO platform_admin (identity_id, level)
SELECT id, 'SUPER' FROM identity WHERE phone = '+849xxxxxxxx';
```

Đăng nhập bằng số đó + mật khẩu → đặt mật khẩu mới → chọn **Quản trị nền
tảng** → `/platform`.

**Người tiếp theo: `/platform/admins`.** Nhập số điện thoại, họ tên, cấp. Số
chưa có mật khẩu thì hệ thống sinh **mật khẩu tạm, hiện đúng một lần** — gửi
riêng cho người nhận; họ phải đổi ở lần đăng nhập đầu. Số đã có tài khoản (vd.
chủ phòng) thì giữ nguyên mật khẩu. Đổi cấp / thu quyền cũng ở màn này, có hiệu
lực ở thao tác kế tiếp của người đó (mỗi thao tác kiểm lại cấp trong CSDL); thu
quyền còn thu hồi luôn phiên nền tảng đang mở. API chặn tự hạ/thu quyền của
chính mình và chặn bỏ người Toàn quyền cuối cùng — mọi thay đổi vào nhật ký.

### 3c. Tự khớp chuyển khoản qua SePay (không bắt buộc)

Không cấu hình thì mọi thứ vẫn chạy: người đối soát đọc sao kê và bấm "Đã nhận
tiền" như cũ. Có SePay thì khoản chuyển **đúng nội dung + đúng số tiền** tự tất
toán hoá đơn (phòng được gia hạn / mở khoá ngay), còn lại vào hàng
**/platform/bank → Cần xử lý**.

1. Sinh khoá: `openssl rand -hex 32`, thêm vào `~/gym/.env`:
   ```
   SEPAY_WEBHOOK_KEY=<chuỗi vừa sinh>
   ```
   rồi `docker compose -f docker-compose.prod.yml up -d api`. Thiếu biến này thì
   endpoint trả 404 — không có cửa nào mở sẵn.
2. my.sepay.vn → **Tích hợp WebHooks** → Thêm:
   - URL: `https://<tên miền>/api/webhooks/sepay`
   - Kiểu chứng thực: **API Key**, giá trị = `SEPAY_WEBHOOK_KEY` ở trên
     (SePay gửi header `Authorization: Apikey <khoá>`)
   - Chỉ gửi giao dịch **tiền vào** của đúng tài khoản `SAAS_BANK_ACCOUNT`.
3. Bấm "Gửi thử" trên SePay: giao dịch thử (nội dung không khớp) phải hiện ở
   `/platform/bank` với nhãn "Không khớp". Đánh dấu "Đã xử lý" là xong.

SePay gửi lại cùng một giao dịch (mạng chập chờn) thì chỉ ghi một lần — khoá
duy nhất `(provider, provider_txn_id)`. Thiếu tiền, dư tiền, chuyển hai lần,
nội dung chứa hai mã hoá đơn: **không tự đoán**, luôn để người quyết.

Vòng đời thuê bao (phát hành hoá đơn, chuyển quá hạn, tạm khoá) do **worker**
chạy mỗi giờ (job `saas-lifecycle`). Worker dừng thì không phòng nào bị khoá
oan — chỉ là hoá đơn phát hành muộn.

### 4. Zalo OA (mỗi phòng tập tự làm, trong giao diện)

Không có cấu hình Zalo chung nào trên máy chủ: mỗi phòng tập gửi tin bằng OA
**của chính họ**. Chủ phòng vào **Cài đặt → Zalo OA**, nhập App ID + Secret key
của ứng dụng Zalo, rồi bấm *Kết nối*. Trong ứng dụng trên developers.zalo.me
phải khai Callback URL đúng như màn hình hiển thị:

```
https://<DEPLOY_DOMAIN>/settings/zalo/callback
```

Secret và token được mã hoá bằng khoá riêng của từng phòng (dẫn từ
`TENANT_SECRET_KEY`). **Đổi `TENANT_SECRET_KEY` là mọi phòng phải kết nối lại.**

Biến tuỳ chọn trong `~/gym/.env`:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `ZALO_DRIVER` | `http` | `log` = không gọi Zalo, chỉ ghi log (máy thử nghiệm) |
| `ZALO_ZNS_DEV_MODE` | `0` | `1` = gửi ZNS ở chế độ development của Zalo |
| `ZALO_OAUTH_BASE`, `ZALO_ZNS_URL` | URL chính thức | chỉ đổi khi Zalo đổi endpoint |
| `SMS_DRIVER` | `off` | SMS dự phòng cho OTP. Chưa có nhà cung cấp thật; `log` bị API từ chối ở production (log chứa mã OTP) |

**Báo phát (không bắt buộc).** Cài đặt → Zalo OA → mục 4 hiện Webhook URL
`https://<DEPLOY_DOMAIN>/api/webhooks/zalo/<id phòng>`. Khai URL đó ở mục Webhook
của ứng dụng Zalo, bật sự kiện nhận thông báo ZNS, rồi dán *OA Secret Key* của
mục Webhook vào ô bên dưới. nginx đã chuyển `/api/*` sang API nên không cần sửa gì.

### 5. Deploy lần đầu

Push lên `main`, hoặc Actions → **Deploy** → *Run workflow*. Muốn có dữ liệu
demo thì tick **seed** (tạo 2 phòng tập với mật khẩu công khai `Matkhau@123` —
đừng tick trên hệ thống có khách thật).

## Vận hành

```bash
cd ~/gym
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f worker   # gửi tin, chiến dịch
IMAGE_TAG=<sha-cũ> ./deploy.sh </dev/null      # quay về bản cũ còn trong máy
```

- **`~/gym/.env` là bí mật duy nhất và không có bản sao nào khác.** Mất nó là mất
  mật khẩu của volume Postgres, `TENANT_SECRET_KEY` (giải mã secret Zalo) và
  `BACKUP_ENCRYPTION_KEY` (giải mã bản sao lưu trên S3). Chép cả tệp vào trình
  quản lý mật khẩu — sao lưu tự động KHÔNG chép `.env` đi đâu cả, cố ý.
- Migration chỉ tiến. Quay về image cũ không hoàn tác schema — mã cũ phải chịu
  được schema mới.
- Deploy in cảnh báo `pt_migrator còn là SUPERUSER` → làm mục **Tách
  `pt_migrator` khỏi superuser** bên dưới một lần.
- Dịch vụ `backup` sao lưu CSDL mỗi đêm và trước mỗi migration — xem **Sao lưu**.
  Deploy in dòng `sao lưu: …` và cảnh báo nếu 26 giờ qua không có bản thành công.
- Worker "unhealthy" = vòng gửi tin không chạm tệp nhịp tim quá 1 phút (treo
  hoặc mất CSDL). Tin không mất: chúng nằm trong `notification_outbox` và được
  gửi tiếp khi worker chạy lại. Tin kẹt ở `SENDING` tự quay lại hàng sau 2 phút.
- **Đối soát dữ liệu** chạy trong worker 6 giờ một lần. Có lệch thì log mức
  `error` bắt đầu bằng `ĐỐI SOÁT LỆCH` và trang `/platform` báo đỏ kèm tên view —
  đó là lỗi hệ thống, báo kỹ sư, đừng sửa tay số liệu. Xem nhanh:
  `docker compose -f docker-compose.prod.yml logs worker | grep "ĐỐI SOÁT"`.
- Worker cũng đóng buổi tập đã xong (`CHECKED_IN` → `COMPLETED`) 15 phút một lần;
  tự đánh vắng chỉ chạy ở phòng nào chủ phòng tự bật.

### Tách `pt_migrator` khỏi superuser (một lần, máy dựng trước 30/09/2026)

Volume Postgres dựng trước ngày đó có `pt_migrator` là SUPERUSER. Máy dựng mới
thì không cần bước này (`01-roles.sh` đã tạo đúng). Cần image có
`db/demote-migrator.ts` (mọi bản deploy từ 30/09/2026).

> **Máy chủ 51.79.255.102 đã làm xong bước này ngày 30/09/2026** (schema 0014,
> 71 đối tượng đổi chủ; bản sao lưu ngay trước: `~/gym/backups/pre-demote-20260929-195029.dump`).
> Script chạy lại vô hại (tự nhận ra "đã xong").

```bash
cd ~/gym
# deploy.sh đã tự thêm DB_SUPERUSER_PASSWORD vào .env; kiểm:
grep -c '^DB_SUPERUSER_PASSWORD=.' .env        # phải ra 1
set -a; . ./.env; set +a                        # nạp biến vào shell, không in ra
docker compose -f docker-compose.prod.yml run --rm -e DB_SUPERUSER_PASSWORD \
  migrate ./node_modules/.bin/tsx db/demote-migrator.ts
```

- API và worker **không cần dừng** (chúng dùng role app_*). Bước chuyển chủ khoá
  từng bảng trong một transaction — request tới lúc đó đợi chừng một giây.
- Chạy lại được: đứt giữa chừng thì chạy lại, pha đã xong tự bỏ qua.
- `DB_PASSWORD` giữ nguyên nghĩa (mật khẩu `pt_migrator`). `postgres` là
  superuser dự phòng — không dịch vụ nào đăng nhập bằng nó.
- Kiểm: `docker compose -f docker-compose.prod.yml exec postgres psql -U pt_migrator
  -d pt -c "select rolsuper, rolbypassrls from pg_roles where rolname = current_user"`
  → `f | t`.

### Sao lưu

Dịch vụ `backup` (image `tools`, script `db/backup.ts`) chạy thường trực:

| Khi nào | Làm gì | Ở đâu |
|---|---|---|
| Mỗi đêm `BACKUP_TIME` (mặc định 02:30) | `pg_dump -Fc` + đếm dòng từng bảng trong **cùng snapshot** | `~/gym/backups/pt-YYYYMMDD-HHMMSS.dump` (+ `.json` kê khai), giữ `BACKUP_KEEP_LOCAL`=7 bản |
| ngay sau đó | mã hoá AES-256-GCM bằng `BACKUP_ENCRYPTION_KEY`, tải lên, đọc lại kích thước | `s3://<bucket>/backups/pt/…dump.enc` + `.json` |
| ngay sau đó | xoay vòng S3: mọi bản của 14 ngày (có bản) gần nhất + bản cuối của mỗi tháng trong 12 tháng gần nhất | `BACKUP_KEEP_DAILY`, `BACKUP_KEEP_MONTHLY` |
| 7 ngày một lần | **khôi phục thử thật**: dựng cụm Postgres tạm trong container, `pg_restore`, so số dòng TỪNG bảng với kê khai | `BACKUP_VERIFY_EVERY_DAYS` (0 = tắt) |
| Mỗi deploy có migration chờ | dump cục bộ trước khi migrate; lỗi thì **dừng deploy** | `~/gym/backups/predeploy-*.dump`, giữ 3 |

- Container khởi động lại mà bản gần nhất đã quá 24 giờ (máy tắt qua đêm, deploy
  đúng 02:30…) thì chạy bù sau 1 phút. Lỗi thì thử lại 3 lần, cách 30 phút.
- **Cảnh báo**: lỗi sao lưu, khôi phục thử lệch, và lúc chạy lại được → POST
  `{"text","content"}` tới `BACKUP_ALERT_WEBHOOK` (Slack, Discord, Google Chat,
  Mattermost nhận thẳng). Webhook không gửi được khi chính container đã chết —
  `BACKUP_HEARTBEAT_URL` phủ chỗ đó: GET sau mỗi lần thành công, dịch vụ ngoài
  báo khi không nhận được. Không đặt cả hai thì chỉ có log + healthcheck:
  `docker compose ps` hiện `backup (unhealthy)` khi 26 giờ không có bản mới.
- Bản cục bộ **không** mã hoá (nằm cạnh chính CSDL, cùng mức lộ; là đường cứu
  nhanh nhất khi còn máy). Bản ra khỏi máy **luôn** mã hoá — dump chứa số điện
  thoại hội viên, và bucket có thể bị cấu hình công khai nhầm.
- Tệp trong `~/gym/backups` thuộc user deploy (không cần sudo để `scp`).
- **Không** sao lưu: tệp S3 của ứng dụng (ảnh, PDF — bật versioning/replication
  ở phía CMC nếu cần), Redis (chỉ là cache + hàng đợi tạm), và `.env`.

```bash
cd ~/gym; C="docker compose -f docker-compose.prod.yml"
cat backups/status.json                                           # lần gần nhất, lỗi, khôi phục thử
$C logs --tail 50 backup
$C exec backup ./node_modules/.bin/tsx db/backup.ts once          # sao lưu ngay (+ tải lên S3)
$C exec backup ./node_modules/.bin/tsx db/backup.ts list          # các bản trên S3
$C exec backup ./node_modules/.bin/tsx db/backup.ts verify /backups/pt-<…>.dump   # khôi phục thử một bản
```

**Mất khoá = mất bản S3.** `BACKUP_ENCRYPTION_KEY` do `deploy.sh` sinh một lần
(in cảnh báo lúc sinh, không in khoá). Chép nó — hoặc cả `.env` — vào trình quản
lý mật khẩu ngay. Mỗi tệp mã hoá ghi vân tay khoá: dùng nhầm khoá thì lệnh giải
mã báo rõ "mã hoá bằng khoá KHÁC", không phải lỗi mơ hồ.

### Khôi phục TOÀN BỘ (mất CSDL / dựng máy mới)

```bash
cd ~/gym; C="docker compose -f docker-compose.prod.yml"
# 0. Máy mới: chép .env CŨ (từ trình quản lý mật khẩu) vào ~/gym/.env TRƯỚC lần
#    deploy đầu — role ứng dụng được tạo với mật khẩu trong đó. Rồi deploy.
# 1. Lấy bản sao lưu: bản cục bộ ~/gym/backups/pt-<…>.dump, hoặc từ S3
$C exec backup ./node_modules/.bin/tsx db/backup.ts list
$C exec backup ./node_modules/.bin/tsx db/backup.ts fetch backups/pt/pt-<…>.dump.enc /backups/restore.dump
#    (kiểm sha256 trước + sau giải mã với tệp .json kê khai)
# 2. Dừng mọi thứ đang ghi, thay CSDL, khởi động lại
$C stop api worker web backup
$C exec -T postgres dropdb -U postgres pt
$C exec -T postgres createdb -U postgres -O pt_migrator pt
$C exec -T postgres pg_restore -U postgres -d pt --exit-on-error < backups/restore.dump
$C run --rm migrate          # bản sao lưu cũ hơn code: nâng schema
$C up -d api worker web backup
```

Máy chưa tách superuser (mục trên) thì chưa có role `postgres`: dùng `-U pt_migrator`.
Chỉ lỗi một phòng thì đừng làm bước 2 — dùng mục kế tiếp.

### Khôi phục MỘT phòng từ bản sao lưu

Schema dùng chung nên `pg_restore` thẳng vào `pt` là khôi phục **mọi** phòng.
Thay vào đó: khôi phục vào CSDL tạm, rồi chép riêng phòng cần. Cần đã tách
superuser (bước trên) — script đăng nhập `postgres`.

```bash
cd ~/gym
C="docker compose -f docker-compose.prod.yml"
set -a; . ./.env; set +a

# 1. CSDL tạm từ bản sao lưu
$C exec -T postgres createdb -U postgres pt_restore
$C exec -T postgres pg_restore -U postgres -d pt_restore < backups/pt-<…>.dump   # hoặc lấy từ S3: db/backup.ts fetch

# 2. Bản sao lưu cũ hơn code hiện tại? Nâng schema của CSDL TẠM (không đụng pt)
export DATABASE_URL="postgres://postgres:${DB_SUPERUSER_PASSWORD}@postgres:5432/pt_restore"
$C run --rm -e DATABASE_URL migrate && unset DATABASE_URL   # -e TÊN: giá trị không nằm trên dòng lệnh

# 3. Chạy thử (chỉ in số dòng từng bảng: hiện tại / bản sao lưu), rồi làm thật
export RESTORE_FROM_URL="postgres://postgres:${DB_SUPERUSER_PASSWORD}@postgres:5432/pt_restore"
export RESTORE_TO_URL="postgres://postgres:${DB_SUPERUSER_PASSWORD}@postgres:5432/pt"
$C run --rm -e RESTORE_FROM_URL -e RESTORE_TO_URL migrate \
  ./node_modules/.bin/tsx db/restore-tenant.ts --tenant <id phòng>
$C run --rm -e RESTORE_FROM_URL -e RESTORE_TO_URL migrate \
  ./node_modules/.bin/tsx db/restore-tenant.ts --tenant <id phòng> --apply

# 4. Dọn
$C exec -T postgres dropdb -U postgres pt_restore
```

Sau khi khôi phục: mọi người của phòng đăng nhập lại (refresh token bị xoá; access
token đang cầm còn dùng tới khi hết hạn). Gói SaaS, tiền phòng đã trả, kết nối
Zalo và lịch sử tin nhắn **giữ nguyên bản hiện tại**. Tệp S3 không được khôi phục.
Nhóm bảng và lý do: README gốc, mục "Khôi phục MỘT phòng".
