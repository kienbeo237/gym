# PT — Quản lý hội viên phòng tập cá nhân (SaaS đa phòng)

PostgreSQL · NestJS · Next.js · S3 · Redis. Một cài đặt phục vụ nhiều phòng tập,
cách ly dữ liệu ở tầng cơ sở dữ liệu.

**Trạng thái: Phase 0 → 7 xong.**
Phase 0 — nền multi-tenant, xác thực hai bước, lát cắt hội viên, cổng gác tự động.
Phase 1 — đăng nhập OTP, huấn luyện viên (khung giờ & hoa hồng), gói tập, tải tệp S3.
Phase 2 — bán gói, hoá đơn trả góp, thu/hoàn tiền, hoa hồng bán hàng, đối soát.
Phase 3 — lịch tập, điểm danh QR, chính sách huỷ/vắng, doanh thu ghi nhận, hoa hồng dạy.
Phase 4 — báo cáo (materialized view), bảng lương huấn luyện viên.
Phase 5 — app hội viên: tổng quan, lịch, lịch sử sổ cái, hoá đơn, tiến độ, điểm danh QR.
Phase 6 — Zalo OA theo từng phòng, worker gửi tin (outbox), chiến dịch chăm sóc.
Phase 7 — gói SaaS & hạn mức, vòng đời thuê bao, quản trị nền tảng, đối soát chuyển khoản.
Xem [Còn phải làm](#còn-phải-làm).

---

## Chạy lần đầu

```bash
cp .env.example .env          # sửa secret trước khi lên môi trường thật
pnpm install
pnpm infra:up                 # postgres + redis + s3, đợi healthy
pnpm db:migrate
pnpm db:seed                  # 2 phòng tập mẫu, mỗi phòng 5 hội viên + 2 PT
pnpm dev                      # api :4000, web :3000
pnpm --filter @pt/api dev:worker   # terminal thứ hai: worker gửi tin, chiến dịch
```

Đăng nhập: `+84901000001` / `Matkhau@123` (chủ phòng Alpha) hoặc `+84902000001`
(chủ phòng Beta). Hai tài khoản thấy hai tập dữ liệu hoàn toàn khác nhau — đó là
phép thử nhanh nhất xem cách ly còn hoạt động.

| Thành phần | Cổng | Ghi chú |
| --- | --- | --- |
| Web (Next.js) | 3000 | |
| API (NestJS) | 4000 | tiền tố `/api` |
| Worker | — | không mở cổng; ở dev `ZALO_DRIVER=log`: tin chỉ in ra log, không gọi Zalo |
| PostgreSQL | **55432** | lệch chuẩn để không đụng dự án khác trên cùng máy |
| Redis | **56379** | |
| S3 (LocalStack) | **59000** | bucket `pt-private` |

**LocalStack thay MinIO là lựa chọn của môi trường dev, không phải của kiến trúc.**
Ảnh `minio/minio` không kéo được từ mạng nội bộ (Docker Hub và quay.io đều trả 401,
đo 29/09/2026), và `localstack/localstack:stable` đã bị gated license — nên ghim
`localstack/localstack:4`. API S3 giống nhau nên mã nguồn không đổi; môi trường
thật dùng S3 của AWS hoặc MinIO cài trên máy chủ.

---

## Trước khi lên môi trường thật

Repo này **công khai**, nên mọi giá trị trong `.env.example` là thứ ai cũng đọc
được. Lớp lỗi cần chặn không phải "lộ mật khẩu dev" mà là `cp .env.example .env`
rồi mang thẳng lên máy chủ: hệ thống chạy hoàn toàn bình thường, không dấu hiệu
nào, và ai đọc repo cũng ký được token hợp lệ.

Ba lớp gác:

1. **`docker-compose.yml` không có giá trị mặc định** cho mật khẩu. Thiếu
   `.env` thì `docker compose up` vỡ ngay với câu chỉ rõ thiếu biến nào — thay
   vì chạy bằng một mật khẩu nằm sẵn trong repo.
2. **Role CSDL nhận mật khẩu từ biến môi trường** (`docker/postgres/init/01-roles.sh`),
   không ghi cứng trong mã nguồn.
3. **API từ chối khởi động** khi `NODE_ENV=production` mà bí mật vẫn là giá trị
   mẫu hoặc ngắn dưới 32 ký tự (`common/config-guard.ts`, 8 phép kiểm).

```bash
# Sinh bí mật mới cho môi trường thật
openssl rand -base64 48   # JWT_ACCESS_SECRET
openssl rand -base64 48   # JWT_REFRESH_SECRET
openssl rand -base64 32   # TENANT_SECRET_KEY
```

Máy chủ dựng TRƯỚC 30/09/2026 còn một việc làm tay một lần: tách `pt_migrator`
khỏi SUPERUSER bằng `db/demote-migrator.ts`. Máy dựng mới thì `01-roles.sh` đã
tạo sẵn đúng. Sao lưu chạy tự động (dịch vụ `backup`), nhưng `BACKUP_ENCRYPTION_KEY`
mà deploy sinh ra phải được chép ra khỏi máy chủ bằng tay — thiếu nó thì bản trên
S3 không giải mã được. Cả hai ở [deploy/README.md](deploy/README.md#vận-hành).

---

## Cách ly đa phòng — đọc mục này trước khi viết dòng code đầu tiên

Toàn bộ thiết kế xoay quanh một câu: **dữ liệu của phòng tập này không được rơi
sang phòng tập khác.** Bốn lớp, cố ý thừa, vì mỗi lớp bắt một kiểu lỗi khác nhau.

### Lớp 1 — RLS ở PostgreSQL

Mọi bảng có `tenant_id` đều bật `ENABLE` **và** `FORCE ROW LEVEL SECURITY`, với
policy so `tenant_id` với `current_setting('app.tenant_id', TRUE)`.

Quên `WHERE tenant_id = ?` trong một query thì kết quả là **0 dòng**, không phải
dữ liệu của người khác. Mặc định đảo chiều: sai thành không thấy gì, chứ không
thành thấy tất cả.

**Năm điều kiện, thiếu một là RLS vô hiệu mà không báo gì:**

1. `FORCE ROW LEVEL SECURITY` — `ENABLE` không áp cho **chủ sở hữu bảng**, mà app
   thường kết nối đúng bằng user đã tạo bảng. Đây là cái bẫy số một.
2. Role của app không `SUPERUSER` và không `BYPASSRLS`. Superuser bỏ qua cả `FORCE`.
3. `set_config(..., TRUE)` = `SET LOCAL`. Dùng `SET` thì ngữ cảnh sống hết đời
   **kết nối**, mà pool tái sử dụng kết nối — request sau của phòng khác kế thừa
   giá trị cũ.
4. `current_setting('app.tenant_id', TRUE)` — thiếu tham số thứ hai thì biến chưa
   đặt sẽ **ném lỗi** thay vì trả `NULL`.
5. Mọi `UNIQUE` index phải có `tenant_id`. Thiếu thì phòng thứ hai không đặt được
   mã `PT10` vì phòng thứ nhất đã dùng — và thông báo "đã tồn tại" vô nghĩa với
   họ, vì màn hình của họ trống trơn.

### Lớp 2 — Khoá ngoại ghép `(tenant_id, id)`

RLS chặn **đọc**; khoá ghép chặn **ghi sai**. Khoá ngoại thường KHÔNG ngăn tham
chiếu chéo tenant: `FOREIGN KEY (member_id) REFERENCES member(id)` vẫn cho phép
dòng của phòng A trỏ sang hội viên phòng B, và Postgres chấp nhận. Vì thế mọi
bảng khai `UNIQUE (tenant_id, id)` làm neo, và mọi FK giữa hai bảng có tenant đều
là khoá ghép.

`booking` đi xa hơn một bước với FK **ba cột**
`(tenant_id, member_package_id, member_id)`: không có cách nào tạo được buổi tập
trừ vào gói của người khác.

### Lớp 3 — Một cửa duy nhất ở tầng ứng dụng

```ts
await this.tdb.run(async (tx) => {
  //  transaction đã đặt app.tenant_id, mọi câu lệnh trong đây bị RLS lọc
});
```

`TenantDb.run()` mở transaction, đặt `app.tenant_id` bằng câu lệnh đầu tiên, rồi
trao transaction cho lời gọi. Service nghiệp vụ **không được** tiêm Kysely thô.

### Lớp 4 — Bốn cổng gác tự động

```bash
pnpm --filter @pt/api test     # 46 phép kiểm
```

| Nhóm | Bắt lớp lỗi |
| --- | --- |
| A. Cấu trúc | bảng mới có `tenant_id` mà quên gọi `enable_tenant_rls()` |
| B. Đặc quyền | role app bị cấp `SUPERUSER`/`BYPASSRLS` khi dựng môi trường |
| C. Khoá | `UNIQUE` thiếu `tenant_id` |
| D. Hành vi | đọc/ghi chéo tenant, bằng **chính role app_rw** |
| Kỷ luật CSDL | tiêm `DB_PLATFORM` vào service nghiệp vụ, hoặc dùng `SET` thay `set_config` |
| Khoá Redis | khoá cache thiếu tiền tố `t:<tenantId>:` — rò dữ liệu qua đường cache |
| Đối soát | 8 view: số dư buổi, tiền đã thu, doanh thu, hoa hồng bán/dạy, bảng lương |
| Matview | materialized view bị cấp quyền cho role của app — RLS **không** bảo vệ được chúng |
| Phạm vi hội viên | phép kiểm "chỉ là hội viên" bị viết lại ở nơi khác thay vì dùng chung |

Bốn nhóm có **test âm** chống tautology: chúng tự tạo một vi phạm giả lập và đòi
bộ nhận diện bắt được. Không có test âm thì một truy vấn luôn trả rỗng cũng làm
mọi thứ xanh, và cổng gác thành trang trí.

Bộ nhận diện phải **chính xác**, không chỉ nghiêm. Bản đầu của cổng gác Redis bắt
`.get(` trần nên kêu oan cả `cfg.get('S3_REGION')`; một cổng gác kêu oan sẽ bị
người ta tắt đi, và khi đó nó tệ hơn không có.

### Ba role, ba mức quyền

| Role | `BYPASSRLS` | Dùng ở đâu |
| --- | --- | --- |
| `app_rw` | **không** | mọi nghiệp vụ, qua `TenantDb` |
| `app_auth` | có, quyền hẹp | chỉ luồng đăng nhập (chạy trước khi có tenant) |
| `app_platform` | có | quản trị nền tảng; mọi thao tác ghi `platform_audit_log` |
| `pt_migrator` | có, **không** SUPERUSER (máy thật) | chủ schema, chỉ chạy migration |
| `postgres` | SUPERUSER (máy thật) | dự phòng sửa tay và khôi phục; không dịch vụ nào đăng nhập bằng nó |

Ở dev và CI `pt_migrator` vẫn là SUPERUSER: bộ test cần `SET ROLE` sang mọi role.

`app_rw` bị thu hồi quyền trên `otp_challenge`, `refresh_token`,
`platform_audit_log` — những bảng đó **không có RLS**, nên quyền thừa là quyền rò.

---

## Những quyết định không hiển nhiên

### Sổ cái buổi tập, không phải cột `remaining`

`session_ledger` chỉ ghi thêm (`delta` ±1), `member_package.sessions_used` là bản
cache ghi trong **cùng transaction**. Cột tự trừ là nguồn của mọi tranh chấp với
khách ("em tập 8 buổi sao trừ 10?") và không hoàn tác được khi huỷ điểm danh nhầm.

Chống trừ hai lần: `uq_ledger_checkin` là partial unique index trên
`(ref_type, ref_id)` — hai thiết bị bấm cùng lúc thì một cái vỡ ở tầng DB, đúng
như mong muốn.

**SỐ DƯ và SỐ BUỔI ĐÃ DÙNG là hai đại lượng khác nhau** (tách ở migration 0010):

| Cột | Nghĩa | Ai giữ |
| --- | --- | --- |
| `sessions_remaining` | `SUM(delta)` — gác việc điểm danh | trigger |
| `sessions_used` | số buổi TIÊU THỤ — con số nghiệp vụ trên báo cáo | service |

Hai số này bằng nhau trong ca thường (`total − used = remaining`) nên rất dễ
tưởng là một. Chúng tách nhau ở đúng ba chỗ, cả ba đều là chuyện thật: **huỷ hợp
đồng**, **tặng thêm buổi**, **chuyển buổi sang gói khác**.

Phát hiện bằng chính view đối soát, trên dữ liệu thật: hợp đồng bị huỷ (mua +10,
hoàn −10) báo lệch −10 trong khi **cả hai con số đều đúng** — số dư 0, đã dùng 0.
Sai nằm ở công thức đối soát. Lỗi thật mà nó kéo theo: `MemberService.list` tính
buổi còn lại bằng `total − used`, nên một dòng `BONUS +5` không hiện ra — hội
viên được tặng buổi mà màn hình vẫn báo số cũ.

**Bốn view đối soát phải RỖNG** và được kiểm trong build, không chờ job đêm: một
view chỉ chạy lúc 2 giờ sáng trên môi trường thật là view không ai đọc kết quả.
**Lệch thì cảnh báo, không tự sửa** — tự sửa là giấu mất nguyên nhân.

### Doanh số PT là BA con số khác nhau

| Con số | Mốc ghi nhận | Bảng |
| --- | --- | --- |
| Tiền thu | ngày tiền vào | `payment` |
| Doanh thu ghi nhận | ngày **buổi tập được dùng** | `revenue_entry` |
| Hoa hồng | `SALE` khi thu tiền, `TEACH` khi dạy | `commission_entry` |

Gộp lại là mất khả năng trả lời "tháng này **thu** bao nhiêu" và "tháng này **làm
ra** bao nhiêu" như hai câu hỏi khác nhau. Gói 50 buổi bán tháng 1, tập tới tháng
8: gộp hết vào tháng 1 thì doanh số PT tháng 2–8 bằng 0 dù ngày nào cũng dạy, và
khi khách hoàn tiền tháng 5 thì hoa hồng đã trả thành công nợ âm không truy được.

`revenue_entry.amount = price_net / sessions_total`, **phần dư dồn vào buổi cuối**.
Chia đều rồi làm tròn từng buổi sẽ lệch tổng vài nghìn đồng mỗi hợp đồng.

**Hoa hồng `SALE` gắn với `payment`, không gắn với hoá đơn.** Nhờ đó trả góp tự
động đúng tỉ lệ: mỗi đợt thu sinh một dòng hoa hồng theo đúng số tiền đợt đó.

`revenue_entry.trainer_id` và `commission_entry.policy_snapshot` đều là **ảnh
chụp tại thời điểm phát sinh**. Đổi PT phụ trách gói, hay sửa chính sách hoa hồng,
đều không được làm đổi số liệu quá khứ.

### Định danh toàn cục + vai trò theo phòng

`identity` (số điện thoại duy nhất toàn cục) tách khỏi `tenant_user` (vai trò tại
từng phòng). Một người là hội viên phòng A và PT phòng B bằng một lần đăng nhập.

**Hệ quả phải biết:** `app_rw` cố ý *không đọc được* định danh của phòng khác. Nên
khi thêm hội viên đã tập ở nơi khác, `SELECT` theo số điện thoại ra 0 dòng còn
`INSERT` thì vỡ `UNIQUE` — triệu chứng là "số điện thoại đã tồn tại" trong khi màn
tìm kiếm không thấy ai. Cửa hẹp cho ca này là hàm `SECURITY DEFINER`
`resolve_or_create_identity()`: nó trả về **đúng một uuid**, không lộ gì khác.

Và vì policy `identity_read` chặn `RETURNING`, đường tạo định danh phải **INSERT
không RETURNING**.

### Đăng nhập hai bước

`/auth/login` trả `preToken` + danh sách phòng; `/auth/select-tenant` mới trả
access token mang `tenantId`. `preToken` cố ý không mở được endpoint nghiệp vụ nào.

Subdomain (`gym-alpha.ptcrm.vn`) chỉ là **gợi ý giao diện**. Sự thật là claim
`tid` trong token đã ký. Lệch nhau thì từ chối, tuyệt đối không âm thầm chuyển
sang tenant của subdomain.

Refresh token **xoay vòng** và có `family_id`: dùng lại token đã bị thay nghĩa là
token bị đánh cắp, hệ thống thu hồi **cả họ**. Ngoại lệ duy nhất: dùng lại
trong **30 giây** sau khi xoay (hai tab cùng hết hạn, request bị huỷ giữa chừng)
thì được cấp token mới trong cùng họ — trừ khi họ đó đã bị thu hồi vì lý do
khác (phát hiện dùng lại, đăng xuất, đổi mật khẩu). Quá 30 giây là trộm.

Web tự làm mới access token trong `middleware.ts`: còn dưới 60 giây (hoặc đã
mất) mà còn refresh token thì gọi `/auth/refresh` trước khi render, gộp các
request song song của cùng một token thành một lần gọi. Refresh bị từ chối thì
xoá cookie và về `/login`; API không gọi được thì để request đi tiếp, không
đăng xuất người dùng vì một lần mạng chập chờn.

**Mật khẩu tạm phải đổi.** Tài khoản tạo kèm mật khẩu tạm (chủ phòng mới, quản
trị viên mới) có `must_change_password`. Đăng nhập bằng nó chỉ được một
`preToken` giai đoạn `CHANGE_PASSWORD` — không chọn được phòng, không vào được
nền tảng — cho tới khi `POST /auth/change-password`. Đổi xong thì mọi refresh
token cũ bị thu hồi.

**Vào nhanh (chỉ máy lập trình).** `DEV_LOGIN_BYPASS=1` trong `.env` mở
`POST /auth/dev-login`: chỉ số điện thoại → `preToken` (`amr: 'dev'`, vào được
cả nền tảng), và tab "Vào nhanh" ở `/login` để thử vai HLV / hội viên không cần
mật khẩu hay kênh OTP. Cần CẢ cờ lẫn `NODE_ENV` khác production — chỉ dựa vào
NODE_ENV thì máy chủ quên đặt nó là mở cửa cho mọi số điện thoại. Ở production:
route trả 404, tab bị loại khỏi bản build, `docker-compose.prod.yml` không truyền
biến này vào container, và API từ chối khởi động nếu thấy nó.

### Chính sách huỷ / vắng mặt

Phòng đặt mặc định ở `tenant_policy`, gói ghi đè từng ô ở `package_template`
(cột `NULL` = theo phòng). Phân giải bằng **một hàm duy nhất**
`resolve_booking_policy()` — ba chỗ `COALESCE` rải rác là ba cơ hội để chúng trôi
khỏi nhau.

Chủ phòng sửa ở **Cài đặt → Đặt lịch & vắng** (`PUT /settings/booking-policy`,
chỉ OWNER, nhật ký ghi đủ trước/sau).

**Worker quét buổi tập 15 phút một lần** (job `booking-sweep`):

- `CHECKED_IN` đã qua giờ kết thúc → `COMPLETED`. Luôn chạy — không động tới tiền.
- **Tự đánh vắng: TẮT mặc định** (`tenant_policy.auto_no_show`). Đánh vắng là
  thao tác trừ buổi của khách, nên máy chỉ làm khi chủ phòng bật. Khi bật: buổi
  `BOOKED` quá **ân hạn + 4 giờ** sau giờ bắt đầu (đúng lúc cửa sổ điểm danh
  đóng — sau mốc đó có muốn điểm danh cũng không được) → `NO_SHOW`, trừ buổi
  theo chính sách như lễ tân bấm tay.
- Đường tự động **không tự trừ** gói đang không `ACTIVE` hoặc đã hết buổi: vẫn
  ghi `NO_SHOW` cho lịch sạch, nhật ký ghi `skippedDeduction`. Máy không tự
  quyết một khoản nợ — lễ tân quyết.
- Mỗi buổi một transaction, khoá dòng: lễ tân vừa xử lý tay thì job bỏ qua; một
  buổi lỗi không chặn cả lô. Người thực hiện ghi `NULL` (hệ thống).

### Tiền: bất biến đặt ở CSDL, không đặt ở service

Tiền được ghi từ nhiều đường — bán gói, thu đợt, hoàn tiền, huỷ hoá đơn, và
phase sau còn thêm. Mỗi đường là một cơ hội quên. Trigger thì không quên được.

| Bất biến | Giữ bởi |
| --- | --- |
| `invoice.paid_amount` và `status` khớp các dòng thu | trigger `sync_invoice_paid` |
| Đợt trả góp tự đóng khi thu đủ | cùng trigger |
| Tổng các đợt = tổng hoá đơn | `CONSTRAINT TRIGGER ... DEFERRABLE` |
| `paid_amount >= 0` | `CHECK` — chặn hoàn quá tay |
| Một lần thu = một dòng | `uq_payment_idem` |
| Số dư buổi tập = `SUM(delta)` | trigger `sync_session_remaining` |

Ràng buộc trả góp **phải** là `DEFERRABLE INITIALLY DEFERRED`: kiểm theo từng
dòng thì không thể đúng — chèn đợt đầu tiên xong là tổng đã lệch. Nó chạy lúc
`COMMIT`, khi cả bộ đợt đã ghi xong.

Service đọc LẠI `invoice` sau khi ghi payment thay vì tự tính lại số dư: hai
công thức song song là hai công thức sẽ lệch.

### Hoàn tiền là dòng MỚI, không phải sửa dòng cũ

`payment.kind = 'REFUND'` với `signed_amount` âm. Dòng thu ban đầu giữ nguyên.
Hoa hồng cũng sinh **bút toán đảo** mang số âm, rơi vào kỳ lương của tháng hoàn
tiền — bảng lương tháng trước đã chốt phải đọc lại được y nguyên. Vì thế
`commission_entry.amount` cố ý **bỏ ràng buộc `>= 0`** ở migration 0009.

### Hoa hồng bán hàng gắn với LẦN THU, không gắn với hoá đơn

Nhờ đó trả góp tự động đúng tỉ lệ mà không cần công thức riêng: thu 1.500.000 thì
hoa hồng tính trên 1.500.000. Hoá đơn nhiều hợp đồng thì chia theo **tỉ lệ giá trị
từng dòng**, phần dư dồn vào dòng cuối, rồi **gộp theo PT** — `uq_comm_sale` là
UNIQUE `(payment_id, trainer_id)` nên hai hợp đồng cùng người bán phải ra một dòng.

Phân giải chính sách theo **bốn mức cụ thể**, một hàm SQL duy nhất:

```
(PT, gói)  >  (PT, mọi gói)  >  (mọi PT, gói)  >  (mọi PT, mọi gói)
```

**PT thắng GÓI** vì hoa hồng là điều khoản thoả thuận với *người* đó, còn tỷ lệ
theo gói chỉ là mặc định của bảng giá. Đảo lại thì một gói khuyến mãi sẽ âm thầm
hạ hoa hồng của PT senior, và không ai phát hiện cho tới kỳ lương.

Không phân giải được thì **chặn ngay lúc BÁN** — sửa cấu hình rồi bán lại là
xong. Ở lúc THU thì không chặn (tiền đã vào két rồi): ghi dòng 0 đồng có cờ
`missing`, và `v_commission_needs_policy` biến nó thành việc phải xử lý thay vì
một khoản nợ PT không ai biết.

### Thu tiền trả góp: tự phân bổ, đợt đến hạn sớm nhất trước

Thu tiền vào hoá đơn trả góp mà **không** chỉ định `scheduleId` thì service tự
chia: lấp đợt đến hạn sớm nhất còn thiếu trước, thừa thì tràn sang đợt kế (đợt
`WAIVED` bỏ qua; vẫn thừa sau đợt cuối thì thành phần thu tự do). "Còn thiếu"
tính từ sổ `payment` theo `schedule_id`, cùng công thức với trigger — không đọc
cột `status`.

Mỗi phần là **một dòng `payment` riêng**, mỗi dòng đúng một dòng hoa hồng
(`v_sale_commission_drift` đòi thế). Khoá chống trùng: phần đầu mang đúng khoá
client gửi, phần sau là `khoá#2`, `khoá#3`… — bấm lại thì va ngay phần đầu và
cả transaction rollback. Kết quả trả về `allocations` để màn thu tiền in ra.

Chỉ định `scheduleId` thì thu đúng đợt đó, không phân bổ.

### Đối soát định kỳ trên dữ liệu thật

Tám view đối soát chạy trong test (dữ liệu seed) **và** trong worker 6 giờ một
lần (job `reconcile`, dữ liệu thật, role `app_platform` — xuyên mọi phòng vì
lệch là lỗi hệ thống). Mỗi lần ghi một dòng `reconciliation_run` (chỉ ghi thêm,
nền tảng không sửa/xoá được). Có lệch: log mức `error` và trang tổng quan nền
tảng báo đỏ kèm tên view; quá 13 giờ không có lần chạy mới: báo vàng (worker có
thể đã dừng). View đối soát chạy bằng quyền chủ nên bỏ qua RLS — đã
`REVOKE` khỏi `app_rw`/`app_auth`.

### Cột `date` KHÔNG được thành `Date`

`date` của Postgres là một ngày trên tờ lịch, không phải một thời điểm. Để
node-postgres dựng nó thành `Date` là tự tạo ra lỗi:

```
String(d)         -> "Sat Nov 28 2026 00:00:00 GMT+0700"   (sai định dạng)
d.toISOString()   -> "2026-11-27T17:00:00Z"                (LÙI MỘT NGÀY)
```

Cái thứ hai nguy hiểm hơn hẳn — nó vẫn ra một ngày **hợp lệ**, chỉ là sai. Hạn
đóng tiền, ngày hết hạn gói, ngày hiệu lực chính sách hoa hồng đều là cột `date`.
Đã gặp thật ở `nextDueDate`. Cách chữa: `types.setTypeParser(DATE, v => v)` —
giữ nguyên chuỗi `YYYY-MM-DD`, không có chỗ cho múi giờ chen vào.

### ⚠️ RLS cách ly PHÒNG TẬP, không cách ly HỘI VIÊN

Khoảng trống này là thứ mà phase 5 (app hội viên) biến thành lỗ hổng thật. Hai
hội viên cùng phòng có mọi dòng mang cùng `tenant_id`, nên RLS cho qua hết.

Đo 29/09/2026 **trước khi vá**, bằng một tài khoản hội viên thật:

| Đường | Kết quả |
| --- | --- |
| `GET /bookings` | 13 buổi, gồm **họ tên, mã hợp đồng, số buổi còn lại** của 2 người khác |
| `POST /files/upload-url` | nhận `ownerId` thẳng từ client → gắn được ảnh tiến độ cho người khác |
| `GET /files/:id/url` | tải được ảnh tiến độ cơ thể của hội viên khác |
| `POST /me/checkin` | quét mã QR của người khác vẫn trả 201 |

Quy tắc, khai ở **một chỗ** (`common/member-scope.ts`): *người chỉ có vai trò
MEMBER thì mọi truy vấn bị ép về chính họ*. Nhân viên thì không — họ cần nhìn cả
phòng tập.

Rải `if (roles.includes('MEMBER'))` khắp service là chắc chắn có chỗ quên, và
chỗ quên không báo lỗi gì. Cổng gác mới cấm mọi cách tự kiểm vai trò MEMBER ngoài
tệp đó — và nó **đã bắt được** một bản sao tôi viết ở phase 3, với điều kiện diễn
đạt hơi khác (`!roles.some(r => r !== 'MEMBER')` thay vì "không có vai trò nhân
viên nào"). Hai câu trùng nhau với 5 vai trò hiện có nhưng tách ra ngay khi thêm
vai trò thứ sáu.

### Thứ tự phép kiểm quan trọng ngang nội dung phép kiểm

Lỗi điểm danh chéo có **hai tầng**, và tầng thứ hai chỉ lộ ra sau khi vá tầng thứ
nhất:

1. thiếu hẳn phép kiểm "đúng người đang xác nhận" — mã QR chứng minh *huấn luyện
   viên đã mở buổi*, nó không chứng minh *ai đang quét*
2. thêm phép kiểm rồi nhưng đặt **sau** nhánh trả về idempotent, nên khi buổi đã
   điểm danh xong thì hội viên B vẫn nhận về **số buổi còn lại và ngày hết hạn
   của A** — không trừ nhầm buổi, nhưng vẫn rò dữ liệu, và lỗi trông "đúng" vì
   trả về 201

Phép kiểm quyền phải đứng ngay sau khi đọc bản ghi, trước mọi nhánh trả về sớm.

### Tệp riêng tư phải khai CHỦ

`PROGRESS_PHOTO` và `MEMBER_AVATAR` là dữ liệu nhạy cảm nhất trong hệ thống.

- hội viên gọi → `ownerId` bị **ép** về chính họ, bất kể client gửi gì
- nhân viên gọi → **bắt buộc** khai tường minh (lễ tân chụp hộ khách là chuyện
  thật, nhưng phải nói rõ chụp cho ai)
- tải về: hội viên khác nhận **404**, không phải 403 — trả 403 là xác nhận tệp đó
  tồn tại
- CSDL có `CHECK file_private_needs_owner` chặn dạng hỏng thứ hai: tệp riêng tư
  **không** khai chủ, tức không quy tắc nào gác được nó

Migration đánh dấu `FAILED` cho dòng đang vi phạm thay vì xoá — tệp vẫn nằm trên
S3, xoá dòng là mất dấu khoá vĩnh viễn.

### Điểm danh bằng QR: mã là một ĐƯỜNG DẪN

`https://app/me/checkin?b=<buổi>&t=<mã>`, không phải chuỗi thô. Camera mặc định
của điện thoại mở được thẳng, nên hội viên không phải cài gì và web **không cần
thư viện quét mã** — thứ mà Safari trên iOS không hỗ trợ sẵn.

Điểm danh chạy khi người dùng **bấm**, không chạy lúc mở trang: nó là thao tác
trừ một buổi tập, và thao tác đổi dữ liệu không nên xảy ra chỉ vì một đường dẫn
được mở (trình duyệt, ứng dụng chat, phần mềm quét virus đều có thể mở trước).

Màn huấn luyện viên tự làm mới mã trước khi hết hạn. Đó là điều làm nó khác một
ảnh chụp màn hình: chụp lại gửi cho người khác thì trong vòng một phút là vô dụng.

### Số đo cơ thể lưu SỐ NGUYÊN

`weight_hg = kg × 10`, `body_fat_pm = % × 10`. Số thực trong CSDL là nguồn của
những con số không bao giờ cộng đúng. Đổi đơn vị ở đúng một tầng (service); API
nhận và trả số thực một chữ số thập phân.

Một hội viên **một bản ghi mỗi ngày** (`uq_member_progress_day`): đo hai lần
trong ngày thì ghi đè, không sinh hai dòng làm biểu đồ răng cưa.

### ⚠️ RLS KHÔNG áp được cho materialized view

Đo thật trước khi thiết kế phase 4:

```
ALTER MATERIALIZED VIEW mv_x ENABLE ROW LEVEL SECURITY;
-- ERROR: This operation is not supported for materialized views.
```

Hậu quả đo được: cấp `SELECT` matview cho `app_rw` rồi đặt `app.tenant_id` =
Alpha, nó đọc được **cả hai phòng tập**. Toàn bộ lớp cách ly của dự án bị vô
hiệu ở đúng chỗ chứa số liệu tổng hợp — thứ mà phòng tập cạnh tranh nhau quan
tâm nhất.

Tệ hơn: **cổng gác nhóm A quét `relkind = 'r'`** (bảng thường) nên matview
hoàn toàn **vô hình** với nó.

Cách làm, và mọi matview về sau phải theo:

1. matview thuộc `pt_migrator`, `REVOKE ALL` khỏi `app_rw` và `app_auth`
2. lộ ra qua một **view thường** có mệnh đề tenant, `security_barrier`
3. view thường chạy bằng quyền của **chủ sở hữu** (không đặt `security_invoker`),
   nhờ đó app_rw đọc qua nó mà không chạm thẳng matview
4. mệnh đề dùng `NULLIF(..., '')` như RLS policy — thiếu nó thì lời gọi chưa có
   ngữ cảnh tenant nhận `invalid input syntax for type uuid` (lỗi 500) thay vì
   0 dòng

Cổng gác mới đòi: không matview nào được `app_rw`/`app_auth` đọc, và mọi view
bọc matview phải chứa `app.tenant_id` trong định nghĩa. Có test âm cấp quyền
giả lập rồi rollback.

### Bảng lương: một dòng hoa hồng thuộc tối đa MỘT bảng lương

Đó là thứ chặn trả hai lần, và nó được ép bằng cột
`commission_entry.payroll_line_id` chứ không bằng phép kiểm ở service.

Chốt lương **đóng băng** số liệu: `base_salary` được chụp ảnh, hoa hồng ghi cứng
vào `payroll_line`. Sửa chính sách hoa hồng hay lương cứng tháng sau không làm
đổi bảng lương đã chốt.

**Cuốn mọi hoa hồng chưa trả có `period_month <= tháng chốt`, không chỉ đúng
tháng đó.** Một lần thu tiền ghi lùi ngày (hoặc buổi tập nhập bù) sinh hoa hồng
thuộc tháng đã chốt xong; nếu chỉ lấy đúng tháng thì khoản đó **không bao giờ
được trả** — nó rơi vào một tháng vĩnh viễn đã đóng.

Đo được: chốt tháng 9 xong, bảng lương tháng 10 của cùng PT về đúng lương cứng,
hoa hồng bán và dạy đều bằng 0.

**Mở lại bảng lương chốt nhầm** (`POST /reports/payroll/reopen`, chỉ OWNER, bắt
buộc lý do ≥ 10 ký tự): xoá `payroll_run` → `payroll_line` (CASCADE) →
`commission_entry.payroll_line_id` về `NULL`. Mọi dòng hoa hồng quay lại "chưa
trả", lần chốt sau cuốn lại đúng chừng ấy dòng. Không con số nào bị sửa tay;
nhật ký giữ ảnh chụp đủ các dòng đã chốt. Ba chặn:

- Đã **chi** (`PAID`) thì không mở — tiền đã ra khỏi két, sai thì điều chỉnh ở
  tháng sau.
- Còn **tháng sau** đã chốt thì không mở tháng trước — mở ngược từ mới nhất về.
- Khoá cùng advisory lock với `close()`: không ai chốt lại giữa chừng.

⚠️ FK hai cột `(tenant_id, payroll_line_id) ON DELETE SET NULL` đặt NULL **cả
hai** cột — kể cả `tenant_id`. Lỗi này nằm im từ 0012 (chưa gì xoá
`payroll_line`) và bị test của thao tác mở lại bắt. Sửa ở 0019 bằng cú pháp
PostgreSQL 15+: `ON DELETE SET NULL (payroll_line_id)`. **FK ghép nào có
`SET NULL` cũng phải ghi rõ cột.**

### Ba loại số liệu, ba nơi đọc khác nhau

| Loại | Nguồn | Vì sao |
| --- | --- | --- |
| Số liệu **của một tháng** | materialized view | tổng hợp nặng, chấp nhận độ trễ |
| **Trạng thái hiện tại** (công nợ, gói sắp hết) | bảng gốc | không thuộc tháng nào |
| Chi tiết một hoá đơn / một buổi | bảng gốc | phải tức thời |

Màn báo cáo **hiển thị mốc làm mới**. Không nói ra thì người dùng đối chiếu với
màn hoá đơn (đọc bảng gốc, luôn tức thời), thấy lệch, và kết luận hệ thống sai.

Mốc đó do chính `refresh_reporting()` ghi vào `reporting_refresh_log` —
PostgreSQL **không lưu** thời điểm `REFRESH MATERIALIZED VIEW`, và suy từ
`pg_stat_get_last_analyze_time` là xấp xỉ sai vì autovacuum chạy độc lập.

### "Doanh thu chưa ghi nhận" là NGHĨA VỤ, không phải tài sản

Tiền đã thu cho những buổi chưa tập. Nếu khách đòi hoàn tiền ngày mai thì đây là
số phải trả lại. Đo trên dữ liệu thật: thu ròng 17,4 triệu nhưng **15 triệu / 36
buổi** chưa ghi nhận. Chủ phòng cần thấy con số này cạnh "đã thu", nếu không sẽ
tiêu vào tiền của những buổi chưa dạy.

### Cột `date` phải có kiểu RIÊNG trong type sinh ra

kysely-codegen ánh xạ cả `date` lẫn `timestamptz` về cùng alias `Timestamp`
(là `Date`). Nhưng từ phase 2 ứng dụng đặt `setTypeParser(DATE, v => v)` nên cột
`date` là **chuỗi** lúc chạy. Hệ thống kiểu nói sai sự thật theo cả hai chiều:

- truyền chuỗi vào `.where('period_month', '=', '2026-09-01')` bị **báo lỗi** dù
  đó chính là thứ đúng
- gọi `.toISOString()` lên giá trị đọc ra thì **biên dịch xanh và vỡ lúc chạy**

Chiều thứ hai sai im lặng. Chữa bằng `db/patch-date-types.ts`: hỏi thẳng CSDL
cột nào là `date` rồi đổi đúng những cột đó sang `DateString` — chính xác và
tất định, không đoán theo tên cột. Chạy tự động trong `pnpm db:types` (20 cột).

### Chỉ xuất `DB`, không xuất interface của từng bảng

kysely-codegen đặt tên interface theo bảng ở dạng PascalCase (`payroll_line` →
`PayrollLine`), và DTO tự viết rất dễ trùng. Khi trùng, TypeScript chọn một
trong hai một cách khó đoán rồi **báo lỗi ở nơi không liên quan** — đã mắc đúng
với `PayrollLine`. Barrel giờ chỉ xuất `DB` và các alias kiểu.

### Tiêu thụ một buổi tập: MỘT nơi duy nhất

Ba đường dẫn tới việc trừ một buổi — **điểm danh**, **vắng mặt**, **huỷ muộn** —
và cả ba phải làm đúng cùng một bộ năm việc:

1. sổ cái −1 buổi (idempotent nhờ `uq_ledger_checkin`)
2. `sessions_used += 1` (`sessions_remaining` do trigger tự lo)
3. `revenue_entry` — doanh thu ghi nhận, một dòng một buổi
4. `commission_entry` kind `TEACH` — **chỉ khi thật sự có buổi dạy**
5. `notification_outbox` — nhắc hội viên số buổi còn lại

Viết ba lần là ba lần lệch nhau, và lệch ở đây là lệch tiền. Nên cả ba đi qua
`SessionConsumptionService.consume()`.

**Vắng mặt và huỷ muộn VẪN ghi nhận doanh thu nhưng KHÔNG trả hoa hồng dạy** —
phòng tập đã bán chỗ đó, nhưng không ai dạy cả. Đo được ngay trong dữ liệu:

| Lý do | Số buổi | Doanh thu | Dòng hoa hồng dạy |
| --- | --- | --- | --- |
| `CHECKIN` | 3 | 1.800.000 | 3 |
| `LATE_CANCEL` | 1 | 600.000 | 0 |
| `NO_SHOW` | 1 | 600.000 | 0 |

⚠️ **Quy tắc này cần chủ phòng xác nhận.** Nhiều phòng tập VẪN trả công cho huấn
luyện viên khi hội viên vắng mặt, vì người đó đã tới và chờ. Muốn đổi thì thêm
cột `pay_teach_on_no_show` vào `tenant_policy` và đọc ở **đúng một chỗ** trong
`consume()` — đừng rải điều kiện ra các service gọi tới.

### Đơn giá buổi tập và phần dư

`price_net / sessions_total`, nhưng buổi **cuối cùng** nhận đúng phần còn lại
chưa ghi nhận. Chia đều rồi làm tròn từng buổi sẽ lệch tổng vài đồng mỗi hợp
đồng và kế toán sẽ trả lại báo cáo.

Buổi vượt quá `sessions_total` (được **tặng** thêm) ghi nhận **0 đồng** — hội
viên không trả tiền cho chúng. Gác bằng `v_revenue_over_contract`.

### Điểm danh: vì sao cần mã QR

Người bấm điểm danh cũng là người ăn hoa hồng dạy. Để huấn luyện viên tự bấm
"đã tập" là bỏ mất chốt kiểm soát — trừ buổi của khách mà không dạy thì không ai
biết. Mã QR buộc hội viên phải có mặt và thao tác.

Mã sống **60 giây**, dùng **một lần** (`uq_checkin_token_open`), so sánh thời
gian hằng. Thiếu ràng buộc một-lần thì chụp màn hình gửi cho nhau vẫn dùng được
và cả phòng điểm danh bằng một ảnh.

Vẫn có đường `PT_CONFIRM` / `ADMIN` cho khi hỏng camera — nhưng `checkin_by`
được ghi lại và hội viên nhận thông báo ngay, đó là cơ chế đối soát thay thế.

**Khoá HỢP ĐỒNG chứ không khoá buổi tập.** Khoá buổi tập chỉ chặn hai lần bấm
cho *cùng* một buổi, mà `uq_ledger_checkin` đã lo ca đó. Cái cần chặn là hai
buổi *khác nhau* của cùng một gói còn đúng một buổi — cả hai cùng đọc "còn 1"
rồi cùng trừ.

Bấm hai lần trả về **cùng kết quả** thay vì ném lỗi: người dùng bấm lại vì mạng
chậm, không phải vì làm sai.

### Chính sách huỷ: ai huỷ quan trọng hơn huỷ lúc nào

**Nhân viên hoặc huấn luyện viên huỷ thì KHÔNG BAO GIỜ trừ buổi của hội viên** —
lỗi từ phía phòng tập không được tính vào gói của khách. Chỉ khi *hội viên* huỷ
mới xét `late_cancel_hours`, và mọi câu trả về đều kèm **lời giải thích** vì sao
bị trừ / không bị trừ, để lễ tân không phải tự diễn giải cho khách.

### Đặt lịch: chặn cả hai chiều thời gian

`booking_window_days` chặn chiều tương lai. Chiều **quá khứ** cũng phải chặn:
nhập bù buổi đã tập là chuyện thật nên không cấm hẳn, nhưng không giới hạn thì
gõ nhầm năm (2025 thay vì 2026) sẽ tạo một buổi cách đây một năm và **không gì
báo** — nó chỉ hiện ra khi ai đó lật lại báo cáo tháng cũ và thấy con số đã đổi.

Đặt lịch **không** trừ buổi (trừ ở lúc điểm danh), nhưng số lịch chưa tập không
được vượt số buổi còn lại — nếu không hội viên đặt 10 buổi khi chỉ còn 2.

### Khoảng ngày trên lịch là ngày VIỆT NAM

`WHERE (starts_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN :from AND :to`.
So thẳng `timestamptz` với ngày sẽ lệch 7 tiếng ở hai đầu — buổi 6h sáng ngày
đầu khoảng và buổi 22h ngày cuối khoảng đều rơi ra ngoài, và người dùng chỉ thấy
"lịch bị thiếu buổi".

### Đăng nhập OTP

Đường chính cho **hội viên** — họ được lễ tân tạo tài khoản rồi không bao giờ
đăng nhập lại cho tới khi cần xem số buổi còn lại, nên mật khẩu là thứ họ không
có. Mật khẩu giữ cho nhân viên.

Sáu điểm bắt buộc, mỗi điểm ứng với một cách phá:

1. **Không lưu mã thô** — lưu sha256.
2. **So sánh thời gian hằng** (`timingSafeEqual`); `===` để lộ thông tin qua thời
   gian phản hồi.
3. **Không tiết lộ số điện thoại có tồn tại hay không** — số lạ vẫn trả
   `{sent: true}`, chỉ là không mã nào được tạo. Trả lỗi khác nhau là biến
   endpoint này thành công cụ dò danh sách khách hàng.
4. **Đếm số lần nhập sai trên chính bản ghi OTP**, không chỉ trên Redis. Redis là
   bộ nhớ tạm; mất nó là mất bộ đếm, và kẻ tấn công chỉ cần chờ nó khởi động lại.
5. **Mã dùng một lần** (`consumed_at`) — nó nằm trong tin nhắn đã gửi đi.
6. **`randomInt` của `node:crypto`**, không phải `Math.random`.

Xin mã mới **vô hiệu mọi mã cũ chưa dùng**. Thiếu bước này thì số lần thử thực tế
nhân lên theo số lần người dùng bấm "gửi lại".

### Redis: giới hạn tần suất và khoá phân tán

Cửa sổ cố định (`INCR` + `EXPIRE`) — hai lệnh, không cần Lua. Sai số tệ nhất là
cho qua gấp đôi hạn mức ở ranh giới cửa sổ; với OTP và đăng nhập thì vô hại.

**Fail-open khi Redis chết, có chủ đích.** Đây là lớp chống lạm dụng, không phải
lớp phân quyền — Redis sập mà chặn hết đăng nhập là tự gây sự cố lớn hơn thứ đang
phòng. Lưới an toàn nằm ở CSDL: số lần nhập sai ở trên chính bản ghi OTP.

Mọi khoá đi qua `redis-keys.ts`, chỉ hai không gian tên: `t:<tenantId>:` cho dữ
liệu của phòng, `g:` cho thứ trước-khi-có-tenant. `tenantKey()` **từ chối** giá trị
không phải uuid — `tenantKey(undefined, …)` sẽ tạo khoá `t:undefined:…` mà mọi
phòng cùng dùng chung, một cache rò hoàn hảo không báo lỗi ở đâu.

### Tải tệp lên S3: ba bước, và bước 3 là bước quan trọng nhất

```
1. xin URL  -> ghi file_object PENDING, ký presigned PUT
2. trình duyệt PUT THẲNG lên S3        (không đi qua API)
3. xác nhận -> HeadObject đọc lại kích thước và kiểu THẬT từ S3
```

Không proxy tệp qua API: mười người cùng tải ảnh 15MB là 150MB nằm trong RAM của
tiến trình Node, và nó chết trước khi ai kịp nhận ra nguyên nhân.

**Bỏ bước 3 thì mọi con số trong CSDL là do client khai.** Client khai 1KB rồi tải
lên 2GB thì hạn mức thành trang trí. Đo thật: client khai 12.345 B, S3 trả về
160 B — con số vào CSDL là 160.

Khoá S3 do **máy chủ** dựng: `t/<tenantId>/<loại>/<uuid><đuôi>`. Tên tệp người
dùng đặt CHỈ dùng để lấy đuôi — nó chứa được `../`, ký tự điều khiển, và tên của
khách hàng khác. Tiền tố tenant được `CHECK file_key_tenant_prefix` ép ở CSDL, nên
lỗi ở tầng ứng dụng vỡ ngay lúc ghi chứ không lặng lẽ đặt tệp vào thư mục phòng
khác.

Hạn URL tải về theo loại tệp: ảnh tiến độ cơ thể **60 giây**, hoá đơn 5 phút, logo
1 giờ.

### Khung giờ PT và chính sách gói: thay TOÀN BỘ, không vá từng phần

`setAvailability` xoá hết rồi ghi lại trong một transaction. Ràng buộc
không-chồng-giờ nằm ở DB (`excl_availability_overlap`), nên vá từng khung sẽ vỡ ở
**trạng thái trung gian** dù kết quả cuối hoàn toàn hợp lệ — ví dụ đổi chỗ hai
khung cho nhau. Xoá-rồi-ghi thì không có trạng thái trung gian nào để vỡ.

Cùng lý do, chính sách hoa hồng của PT là **bản ghi có hiệu lực theo ngày**, không
sửa tại chỗ: hoa hồng đã tính của tháng trước phải giữ nguyên căn cứ của nó.

### Múi giờ

Lưu `timestamptz`, gộp báo cáo bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'`. Buổi 6h
sáng ngày 1 theo giờ VN là 23h ngày 30 theo UTC — gộp theo UTC là lệch đúng những
ngày đầu/cuối tháng, và không ai phát hiện cho tới lúc chốt lương.

### Tiền

`bigint`, đơn vị **đồng**. Không có số thực ở bất cứ đâu chạm tới tiền.

### Gửi tin Zalo: hộp thư đi LÀ hàng đợi

Nghiệp vụ (điểm danh, trừ buổi, OTP, chiến dịch) chỉ **ghi một dòng**
`notification_outbox` trong transaction của chính nó. Tiến trình **worker**
(`src/worker.ts`, cùng image với API, lệnh `node dist/worker.js`) nhặt dòng và
gọi Zalo. Gọi HTTP ngay trong transaction thì Zalo chậm là giữ khoá trên
`member_package` và kéo sập luồng điểm danh.

**Không dùng BullMQ.** Bảng outbox đã là hàng đợi bền, có RLS, có idempotency key,
xem được bằng SQL. Đẩy thêm sang Redis là hai nguồn sự thật phải đồng bộ, và
Redis mất dữ liệu thì tin mất theo. Lấy việc bằng `FOR UPDATE SKIP LOCKED`, qua
hàm `outbox_claim_due()`:

- đánh dấu `SENDING` + `attempts + 1` + **lease** 2 phút rồi COMMIT ngay; worker
  chết giữa chừng thì hết lease dòng tự quay lại hàng
- hàm là SECURITY DEFINER nên trả **chỉ `(id, tenant_id)`**; nội dung tin đọc
  sau qua `runAs(tenantId)`, tức vẫn qua RLS
- chạy 2 worker vẫn đúng: SKIP LOCKED chia việc, job định kỳ có khoá Redis

Mỗi tin đi **ba pha**: đọc (transaction) → gọi Zalo (KHÔNG transaction) → ghi kết
quả (transaction, **rào bằng `attempts`**: lease đã hết và worker khác nhặt lại
thì lần ghi cũ bị bỏ). Bảo đảm là *ít nhất một lần*; `tracking_id` gửi kèm là
`id` của dòng.

`FAILED` ≠ `SKIPPED`. `FAILED` là Zalo từ chối hoặc hết 5 lần thử (lùi 30s·4ⁿ).
`SKIPPED` là **chưa cấu hình được**: OA chưa kết nối, mẫu chưa duyệt, hội viên
không có số điện thoại, tin quá 24h. Màn "Tin nhắn" hiện lý do, và nút "Gửi lại"
chỉ có ở hai trạng thái đó.

**OA của từng phòng.** Hội viên thấy tên phòng tập, không thấy tên nền tảng, nên
mỗi phòng tự khai App ID/Secret, tự cấp quyền (OAuth v4 + PKCE, `state` nằm
trong Redis 10 phút và **chỉ dùng được một lần**), tự đăng ký mẫu ZNS. Secret và
hai token mã hoá AES-256-GCM (`common/secret-box.ts`) bằng khoá **dẫn riêng cho
từng phòng** từ `TENANT_SECRET_KEY`, AAD = `phòng|mục đích`: chép bản mã sang
phòng khác hay tráo cột đều giải mã thất bại, không ra giá trị sai.

**Refresh token Zalo dùng MỘT lần.** Hai tiến trình cùng làm mới thì một cái cầm
token chết và cả phòng ngừng gửi tin. Nên làm mới nằm trong khoá phân tán, đọc
lại token **bên trong** khoá, và **fail-closed** khi Redis chết (ngược với giới
hạn tần suất): thà chậm vài phút còn hơn mất kết nối OA.

**OTP đi qua outbox**, do `app_auth` ghi. `app_auth` có BYPASSRLS nên chỉ được
cấp **theo cột**: đọc `(tenant_id, status)` của OA và mẫu tin, ghi outbox —
không đọc được secret/token, không đọc lại được tin. Mã OTP trong payload là bản
niêm phong, bị xoá khi tin tới trạng thái cuối, và tin OTP không bao giờ gửi lại.

**Chiến dịch chạy lại bao nhiêu lần cũng không gửi trùng**: `campaign_enrollment`
+ `cooldown_days` cho loại neo theo gói, idempotency key theo ngày / năm / đợt
trả góp cho loại còn lại. Job chạy mỗi 30 phút trong 9h–20h; tin xếp ngoài
8h–21h tự dời sang 8h sáng hôm sau. Chiến dịch **bị chặn** (OA chưa kết nối, mẫu
chưa duyệt) không xếp tin nào — xếp rồi bỏ qua hàng loạt chỉ làm rác nhật ký.

Worker còn chạy: làm mới token OA sắp hết hạn (30 phút), làm tươi báo cáo (15
phút, khoá toàn cục), dọn tệp S3 mồ côi (60 phút). Sức khoẻ = tệp nhịp tim mà
vòng gửi tin chạm mỗi ~3 giây.

Cổng gác mới ở nhóm B: mọi hàm SECURITY DEFINER mà `app_rw` gọi được phải nằm
trong danh sách đã duyệt kèm lý do (Postgres mặc định cấp EXECUTE cho PUBLIC —
quên `REVOKE` là mở cửa xuyên RLS), và quyền theo cột của `app_auth` được thử
bằng chính role đó.

### Gói SaaS: chuyển khoản thủ công, vòng đời nằm trong SQL

Phòng tập trả tiền cho nền tảng bằng **chuyển khoản**; người quản trị đối chiếu
sao kê rồi bấm xác nhận. Không cổng thanh toán: ở quy mô vài chục phòng, một
người đối soát mỗi sáng rẻ và ít rủi ro hơn tích hợp cổng.

**`current_period_end` = "đã trả tới"** cho mọi trạng thái, kể cả dùng thử.
Một mốc duy nhất quyết định mọi thứ:

| Khi nào | Việc gì |
| --- | --- |
| 7 ngày trước khi hết kỳ | phát hành hoá đơn kỳ tới (mỗi phòng tối đa MỘT hoá đơn mở) |
| hết kỳ chưa trả | thuê bao + phòng → `PAST_DUE`: vẫn dùng bình thường, bị nhắc |
| quá 7 ngày ân hạn | phòng → `SUSPENDED` (kiểu `BILLING`) |
| hoá đơn `PAID` / `WAIVED` | gia hạn tới hết kỳ đã trả, mở khoá **chỉ** kiểu `BILLING` |
| gói 0đ hết kỳ | tự sang kỳ mới, không hoá đơn |

Mọi chuyển trạng thái nằm trong **hàm SQL** (`saas_issue_invoice`,
`saas_settle_invoice`, `saas_lifecycle_tick` — migration 0016), chỉ
`app_platform` gọi được; TypeScript chỉ gọi hàm. Lý do: job của worker và nút
bấm của quản trị viên cùng đổi một trạng thái — hai bản cài đặt sẽ trôi khỏi nhau.
Test chạy hàm với `p_today` tuỳ ý (năm 2030, trong transaction rồi ROLLBACK),
không phải chờ lịch để kiểm "quá 7 ngày".

**Nội dung chuyển khoản là khoá đối soát**: `PT<YYMM> <SLUG> <4 hex>`, ví dụ
`PT2610 GYMALPHA 1CCA`, UNIQUE trên các hoá đơn còn sống. Ngân hàng hay nuốt
khoảng trắng, nên ô tìm so sánh sau khi bỏ hết khoảng trắng. Xác nhận **thiếu
tiền bị từ chối** (huỷ và phát hành lại đúng số đã thoả thuận), **dư tiền phải
ghi chú**, và một mã giao dịch ngân hàng chỉ tất toán được một hoá đơn.

**Khoá tay ≠ khoá do nợ.** `tenant.suspend_kind` phân biệt hai loại. Trả tiền
chỉ mở khoá do nợ; phòng bị khoá vì vi phạm không tự mở lại khi chuyển khoản.
Mở khoá tay thì trạng thái lấy lại từ thuê bao — phòng còn nợ về `PAST_DUE`:
mở khoá không phải xoá nợ.

**Bị khoá = chỉ đọc**, kiểm ở MỌI request (`TenantStatusGuard`, nhớ đệm 30s),
không chỉ lúc đăng nhập — access token cũ còn sống tới 15 phút. GET vẫn chạy
(chủ phòng phải xem được hoá đơn để trả tiền); ghi trả 403 `TENANT_SUSPENDED`.
Phòng `CLOSED` thì 401 cả khi đọc. `app_rw` bị thu quyền UPDATE cột
`status` của `tenant` — phòng không tự mở khoá cho mình được, kể cả qua lỗi
ở service.

**Hạn mức tin là hạn mức MỀM.** Chỉ đếm `ZALO_ZNS` trong tháng (giờ VN). Hết
hạn mức thì worker đánh `SKIPPED` lý do `QUOTA_EXCEEDED` và chiến dịch báo "bị
chặn" — trừ tin OTP đăng nhập (khoá người ta ra khỏi hệ thống vì hết tin là
sai).

**Hạn mức hội viên / HLV là hạn mức CỨNG, nhưng chỉ chặn TẠO MỚI.** Tạo quá
hạn mức trả 403 `PLAN_LIMIT_REACHED` kèm câu hướng dẫn nâng gói (kiểm trong
`assert_quota`, cùng transaction với lệnh INSERT nên hai lễ tân bấm cùng lúc
không lọt). Người đang có không bị ảnh hưởng: hạ gói khi đang đông khách không
khoá ai ra ngoài, chỉ không thêm được nữa.

**Đổi gói theo yêu cầu.** Chủ phòng bấm "Nâng lên / Chuyển sang gói này" ở
Cài đặt → Gói dịch vụ; người vận hành duyệt hoặc từ chối (bắt buộc lý do) ở
`/platform/plan-requests`. Mỗi phòng tối đa MỘT yêu cầu đang chờ (unique index
một phần). `app_rw` chỉ được tạo yêu cầu `PENDING` và chuyển nó sang
`CANCELLED` — policy RESTRICTIVE chặn phòng tự duyệt cho mình, kể cả qua lỗi ở
service. Không tính chênh lệch giữa kỳ: hạn mức mới có hiệu lực ngay, giá mới
áp từ hoá đơn kỳ sau. Gửi yêu cầu hạ xuống gói chật hơn số đang có bị từ chối
ngay (`PLAN_TOO_SMALL`).

**Tự khớp chuyển khoản (SePay).** `POST /api/webhooks/sepay` (khoá API, so
sánh thời gian hằng) gọi hàm SQL `saas_ingest_bank_txn` (0017): ghi giao dịch
một lần duy nhất theo `(provider, provider_txn_id)`, chuẩn hoá nội dung (bỏ
khoảng trắng / dấu chấm, chữ hoa) rồi tìm mã hoá đơn đang chờ. Khớp **đúng
một** hoá đơn **và đúng số tiền** thì gọi chính `saas_settle_invoice` như nút
bấm, người xác nhận = hệ thống. Lệch tiền, chuyển trùng, không khớp, khớp nhiều
hoá đơn → hàng "Cần xử lý" ở `/platform/bank`; không có gì tự đoán. Bảng
`bank_txn_event` không ai xoá được (kể cả `app_platform`), `app_rw` không đọc
được.

### Quản trị nền tảng: phiên riêng, nhật ký chỉ ghi thêm

Phiên nền tảng là token **không có `tid`**, `scope: 'platform'`, cấp
`SUPPORT < OPS < SUPER`. Chỉ cấp khi đăng nhập bằng **mật khẩu** (`amr: 'pwd'`):
ai cầm được điện thoại của quản trị viên để nhận OTP không vì thế mà nhìn được
mọi phòng tập. Refresh token nền tảng sống 1 ngày và kiểm lại `platform_admin`
mỗi lần xoay.

Hai chiều đều đóng: route `@Platform()` chỉ nhận token nền tảng; token nền tảng
gọi route phòng tập bị 403 `PLATFORM_TOKEN_NOT_FOR_TENANT_ROUTE`. Cổng gác kiểm
mọi controller dưới `src/platform/` gắn `@Platform()` **ở class**, và chỉ
mặt phẳng nền tảng + worker được tiêm `PlatformDb`.

`PlatformDb.run(người, cấp, nhật ký, fn)` là cửa duy nhất tới kết nối
`app_platform`: một transaction **kiểm lại cấp trong CSDL** (thu hồi quyền có
hiệu lực ngay, không chờ token hết hạn), chạy `fn`, rồi ghi
`platform_audit_log` — **kể cả thao tác đọc** (ai đã xem dữ liệu phòng nào).
`app_platform` bị thu UPDATE/DELETE/TRUNCATE trên bảng nhật ký: SUPER cũng
không xoá được dấu vết của mình.

Cấp / đổi cấp / thu quyền quản trị viên ở `/platform/admins` (chỉ SUPER). Không
tự hạ hay thu quyền của chính mình, không bỏ được người SUPER cuối cùng; thu
quyền thu hồi luôn phiên nền tảng đang mở.

### Đổi lịch là thao tác RIÊNG, không phải huỷ + đặt lại

`POST /bookings/:id/reschedule` giữ nguyên buổi (cùng id, cùng trạng thái
`BOOKED`), chỉ đổi giờ — **không bao giờ trừ buổi**. Huỷ rồi đặt lại thì huỷ
sát giờ bị tính huỷ muộn, sai ý người dùng.

Chính vì không trừ buổi nên hội viên **chỉ tự đổi được khi còn ngoài khung huỷ
muộn** của gói (`RESCHEDULE_TOO_LATE`): trong khung đó, đổi sang tuần sau chính
là huỷ muộn trá hình. Nhân viên / HLV đổi lúc nào cũng được, có ghi nhật ký. Giờ
mới đi qua cùng các phép kiểm của đặt lịch (HLV trùng giờ, hội viên trùng giờ,
cửa sổ đặt trước) — buổi bị đổi được loại khỏi phép kiểm trùng với chính nó.

`GET /bookings/slots` trả khung trống 30 phút một bước theo lịch nhận dạy của HLV,
đã trừ buổi đang có. HLV chưa khai lịch thì gợi ý theo giờ mở cửa 06:00–21:00 —
đặt ngoài khung vẫn được, giống API đặt lịch. Mỗi `BookingItem` mang sẵn
`lateCancelHours` (đã gộp chính sách gói + phòng) để màn hình báo trước "huỷ bây
giờ sẽ bị trừ buổi" thay vì chỉ báo sau khi huỷ.

### Hoá đơn PDF sinh lúc tải, không lưu

`GET /invoices/:id/pdf` dựng PDF (pdfkit + phông Be Vietnam Pro nhúng) từ dữ
liệu hiện tại mỗi lần gọi. Cột `invoice.pdf_file_id` **cố ý để trống**: hoá đơn
còn đổi (thu thêm đợt, hoàn tiền), lưu tệp thì phải lo tệp cũ lệch số liệu. Đây
**không phải hoá đơn GTGT** — chân trang ghi rõ. Hội viên tải được hoá đơn của
chính mình (hoá đơn người khác trả 404, như mọi chỗ khác), qua `/api/proxy` để
web gửi kèm phiên.

### Đổi hoa hồng hai lần trong một ngày

Hoa hồng mới luôn áp từ **ngày mai** (hoa hồng đã tính giữ căn cứ). Đổi lần hai
trong cùng ngày: bản ghi "từ ngày mai" của lần trước bị **xoá** rồi mới đóng bản
đang mở và thêm bản mới — nếu không, hai chính sách cùng `effective_from` vi
phạm `comm_policy_date_order`. Chỉ xoá bản CHƯA có hiệu lực, nên không hoa hồng
nào đã tính bị mất căn cứ.

### Bán gói: tiền trả trước vào ĐỢT 1

Bán trả góp kèm tiền thu ngay thì toàn bộ số đó ghi vào đợt 1, nên màn bán gói
chặn số trả trước ≤ đợt 1. Muốn trả hơn thì thu tiếp ở màn hoá đơn — tự phân bổ
đợt đến hạn sớm nhất trước.

### Báo phát ZNS: một CỘT, không phải trạng thái mới

`SENT` vẫn là "Zalo đã nhận yêu cầu". Zalo báo hội viên đã nhận (sự kiện
`user_received_message`) thì ghi `notification_outbox.delivered_at` — **không**
thêm trạng thái `DELIVERED`. Báo phát tới muộn, tới hai lần, hoặc tới TRƯỚC khi
worker kịp ghi `SENT` (Zalo trả lời chậm hơn sự kiện); một cột thời điểm chịu
được cả ba, còn một trạng thái thì phải xử lý chuyển trạng thái ngược.

URL mang sẵn phòng: `/api/webhooks/zalo/<tenantId>`. Mỗi phòng một OA và một
khoá riêng, nên phải biết phòng TRƯỚC khi kiểm chữ ký — đoán từ `app_id` trong
thân (chưa kiểm) là tin dữ liệu chưa xác thực. Chữ ký
`mac = sha256(app_id + thân thô + timestamp + OA secret key)` tính trên **byte
thô** (`rawBody: true` ở main.ts) — JSON.stringify lại đổi thứ tự khoá / khoảng
trắng là chữ ký sai. Khớp tin bằng `tracking_id` (= id dòng, gửi kèm khi gửi)
hoặc `msg_id`, **qua RLS của phòng trong URL**: URL phòng A không chạm được tin
phòng B dù biết id. Không khớp thì trả 200 và ghi cảnh báo — trả lỗi thì Zalo
gửi lại mãi một sự kiện không bao giờ khớp.

### SMS dự phòng: chỉ cho OTP

Mã OTP sống 5 phút, lượt thử lại thứ hai của worker là 30 giây sau, lượt ba 2
phút: chờ thử lại Zalo là hội viên hết hạn mã. Nên OTP gửi Zalo hỏng (không có
Zalo, mẫu chưa duyệt, token chết...) thì **ngay trong transaction ghi kết quả**
sinh một dòng `SMS` mang theo mã niêm phong (idempotency `<khoá>:SMS`), dòng Zalo
kết thúc với lý do "… — đã chuyển sang SMS". Không phòng nào có Zalo thì OTP
xếp thẳng dòng SMS vào phòng gắn bó gần nhất. Mã đã hết hạn thì không chuyển.

Tin chăm sóc **không** có bản SMS (`SMS_TEMPLATE_UNSUPPORTED`): SMS tính tiền
từng tin, tự bật cho chiến dịch là hoá đơn bất ngờ. Nội dung SMS **không dấu**
(tin có dấu là UCS-2, 70 ký tự/tin thay vì 160).

`SMS_DRIVER`: `log` (mặc định ở dev) ghi tin ra log — **config-guard chặn ở
production** vì log chứa mã OTP thô; `off` (mặc định ở production) không gửi.
Chưa có driver nhà cung cấp thật: `sms/sms-api.ts` là chỗ cắm duy nhất.

### `pt_migrator`: không SUPERUSER nhưng CÓ `BYPASSRLS`

Ảnh Docker Postgres làm `POSTGRES_USER` thành **bootstrap superuser** (OID 10) —
Postgres không cho hạ quyền role đó, cũng không `REASSIGN OWNED` được (nó sở hữu
cả catalog). Nên máy thật dựng với `POSTGRES_USER=postgres`, và `01-roles.sh`
tạo `pt_migrator` thường làm chủ CSDL. Máy dựng trước đó: `db/demote-migrator.ts`
đổi tên bootstrap thành `postgres`, tạo lại `pt_migrator` (giữ mật khẩu cũ, nên
`.env` không đổi), chuyển chủ từng đối tượng, và **chép lại `ALTER DEFAULT
PRIVILEGES`** — 0005 đặt quyền mặc định theo OID role cũ, không chép thì bảng
tạo ở migration sau không tự cấp quyền cho `app_rw`.

`BYPASSRLS` là cố ý: hàm SECURITY DEFINER (tra danh tính, làm mới báo cáo, lấy
việc outbox) và view đối soát chạy bằng quyền chủ sở hữu, mà mọi bảng `FORCE ROW
LEVEL SECURITY` — chủ không có nó thì các hàm đó nhận 0 dòng. Thứ bỏ đi là
SUPERUSER: `COPY … TO PROGRAM`, đọc tệp máy chủ, `ALTER SYSTEM`, tạo role,
extension không tin cậy. Đã kiểm: toàn bộ 20 migration chạy từ đầu bằng
`pt_migrator` thường, và 139 test xanh trên cả CSDL dựng mới lẫn CSDL vừa tách.

### Sao lưu: một snapshot, đếm rồi mới tin

`db/backup.ts` chạy thành dịch vụ `backup` (image `tools`). Mỗi đêm: mở giao dịch
`REPEATABLE READ`, `pg_export_snapshot()`, đếm dòng từng bảng trong snapshot đó,
rồi `pg_dump --snapshot` — tệp dump và con số đếm là của **cùng một thời điểm**.
Nhờ vậy khôi phục thử (7 ngày một lần, vào một cụm Postgres tạm dựng ngay trong
container) so được **từng bảng**, không chỉ "pg_restore thoát mã 0". Một bản dump
mở được nhưng thiếu dữ liệu là loại hỏng không ai phát hiện tới ngày cần nó.

- **Dump bằng `pt_migrator`**, không bằng role ứng dụng: RLS áp lên `app_rw` thì
  `pg_dump` thấy 0 dòng của mọi phòng (hoặc từ chối chạy) — chủ schema BYPASSRLS.
- **Mã hoá trước khi ra khỏi máy** (AES-256-GCM, khoá 32 byte trong `.env`, ghi
  vân tay khoá vào đầu tệp). Bản cục bộ thì không: nó nằm cạnh chính CSDL.
- **Xoay vòng S3 chỉ đụng tên do chính nó đặt** (`pt-YYYYMMDD-HHMMSS.dump.enc|.json`)
  trong prefix riêng — tệp lạ, tệp ứng dụng không bao giờ bị xoá. Giữ luôn bản
  mới nhất dù cấu hình gì. "14 ngày" là 14 ngày CÓ bản: sao lưu hỏng hai tuần
  thì bản cũ không bị xoá dần theo lịch.
- **Trước migration**: `deploy.sh` chụp một bản cục bộ nếu có migration chờ, lỗi
  thì dừng deploy. Migration chỉ tiến; đây là đường quay duy nhất.
- **SDK S3 không gửi checksum mặc định** (`WHEN_REQUIRED`): SDK mới gắn CRC32 dạng
  `aws-chunked`, nhiều S3 tương thích (Ceph — CMC) từ chối. Xoá từng đối tượng
  thay vì `DeleteObjects` (cần Content-MD5, mỗi nhà cung cấp xử lý một kiểu).
- **Không sao lưu** `.env` (chứa chính khoá giải mã), Redis (cache + hàng đợi
  tạm), tệp S3 của ứng dụng (việc của versioning phía nhà cung cấp).

Kiểm 30/09/2026 trên CSDL dev (44 bảng, ~20 000 dòng): dump 2 s, khôi phục thử
15–18 s khớp mọi bảng; qua một S3 giả lập: tải lên/tải về/giải mã khớp sha256,
xoay vòng giữ đúng ngày/tháng và bỏ qua tệp lạ, không có header `aws-chunked`;
sửa 1 bit bản mã → từ chối giải mã; sai khoá → báo vân tay khác; webhook báo lỗi
và báo "chạy lại được".

### Khôi phục MỘT phòng: bốn nhóm bảng

`db/restore-tenant.ts` chép một phòng từ CSDL tạm (bản sao lưu đã `pg_restore`)
về CSDL thật. Mỗi bảng có `tenant_id` thuộc đúng một nhóm; bảng mới chưa xếp
nhóm thì script **dừng**:

| Nhóm | Bảng | Vì sao |
| --- | --- | --- |
| khôi phục | hội viên, gói, sổ cái, lịch, hoá đơn, hoa hồng, bảng lương… | dữ liệu nghiệp vụ, về đúng trạng thái lúc sao lưu |
| xoá | `refresh_token`, `checkin_token` | khôi phục phiên = hồi sinh token cũ; mọi người đăng nhập lại |
| giữ | gói SaaS, hoá đơn SaaS, OA Zalo, hộp thư đi, bộ đếm tin | quan hệ với NỀN TẢNG (tiền phòng đã trả sau ngày sao lưu), refresh token Zalo đã xoay |
| bù thêm | `audit_log` | giữ nhật ký hiện tại, bù dòng chỉ có trong bản sao lưu |

Chép với `session_replication_role = replica` (tắt trigger): bản sao lưu đã là
trạng thái cuối, chạy lại trigger cập nhật số dư là cộng hai lần, và trigger
chỉ-ghi-thêm chặn xoá sổ cái. FK cũng là trigger nên cũng tắt — script tự kiểm
**mọi** khoá ngoại dính tới phòng và tám view đối soát trước COMMIT; lệch là
ROLLBACK. Dòng chuyển dạng JSON văn bản (`row_to_json` → `json_populate_recordset`)
nên timestamptz giữ đủ micro giây, numeric đủ chữ số; cột `GENERATED` bỏ khỏi
danh sách chèn. Schema bản sao lưu phải cùng migration với CSDL thật — cũ hơn
thì chạy migration lên CSDL tạm trước. Kiểm trên cụm thử: bảng nghiệp vụ khớp
bản sao lưu **từng byte** (md5), phòng khác không đổi một dòng, tạo lại được cả
phòng đã bị xoá, dừng khi số điện thoại đã thuộc người khác.

### Kiểm thử tải

`pnpm loadtest:seed` tạo phòng `loadtest` (300 hội viên, 10 HLV, 6 000 buổi lịch sử,
~8 giây); `pnpm loadtest` chạy N người dùng ảo trộn đọc (tổng quan, lịch, khung
trống, sổ buổi, màn chủ phòng) và ghi (đặt khung trống rồi huỷ). Đo 30/09/2026
trên máy dev — API, Postgres, Redis và máy tạo tải **chung một CPU**, API ở chế
độ dev:

| Người dùng ảo | req/s | p50 | p95 | p99 | lỗi |
| --- | --- | --- | --- | --- | --- |
| 20 | 139 | 137 ms | 217 ms | 286 ms | 0 |
| 80 | 213 | 336 ms | 605 ms | 751 ms | 0 (8 tranh chấp khung giờ, trả `TRAINER_BUSY` đúng) |

Bão hoà quanh ~210 req/s: tăng người dùng chỉ tăng độ trễ. Để so: một phòng 300
hội viên giờ cao điểm chưa tới 1 req/s. Sau 80 người dùng ảo đặt/huỷ 700 lần: 0
buổi bị trừ oan, sổ cái khớp. Số để chọn cấu hình máy thật phải đo từ máy KHÁC
vào staging (`LT_BASE=…`).

---

## Migration

```bash
pnpm db:migrate     # áp file chưa chạy
pnpm db:status      # liệt kê trạng thái
pnpm db:types       # sinh lại type Kysely từ CSDL (sau khi đổi schema)
```

SQL viết tay là **nguồn sự thật**, type sinh ngược từ CSDL bằng `kysely-codegen`.
Ngược lại (sinh SQL từ model) không diễn đạt được RLS policy, khoá ngoại ghép,
`EXCLUDE USING gist`, partial unique index hay cột `GENERATED`.

Ba quy tắc:

- **Chỉ tiến, không lùi.** Sai thì viết file mới.
- **Không sửa file đã chạy.** Runner so checksum và chặn — môi trường khác đã áp
  bản cũ, hai CSDL sẽ lệch mà không ai biết.
- **Bảng mới có `tenant_id` phải gọi `SELECT enable_tenant_rls('<bảng>');`**
  Quên thì nhóm gác A đỏ.

`db.ts` (type sinh ra) **được commit**: build và CI không cần CSDL để biên dịch.

---

## Bố cục

```
apps/api/            NestJS
  src/common/        TenantDb, ngữ cảnh tenant, guard, pipe zod
  src/db/            ba kết nối / ba role
  src/redis/         token DI, giới hạn tần suất, không gian tên khoá
  src/auth/          đăng nhập hai bước (mật khẩu + OTP), refresh xoay vòng
  src/member/        lát cắt nghiệp vụ mẫu — đọc nó trước khi viết module mới
  src/trainer/       PT, khung giờ, chính sách hoa hồng
  src/package/       gói tập, chính sách huỷ/vắng ghi đè
  src/storage/       presigned S3 ba bước
  src/commission/    phân giải chính sách + ghi hoa hồng (SALE nay, TEACH phase 3)
  src/sale/          bán gói: hợp đồng + sổ cái + hoá đơn + trả góp, một giao dịch
  src/billing/       hoá đơn, thu tiền, hoàn tiền, huỷ
  src/attendance/    lịch tập, điểm danh QR, tiêu thụ buổi (một nơi duy nhất)
  src/report/        bảng điều khiển, báo cáo PT/gói, bảng lương
  src/me/            app hội viên — không endpoint nào nhận memberId từ client
  src/zalo/          kết nối OA (OAuth + PKCE), token mã hoá, gọi Zalo (driver http | log)
  src/notification/  hộp thư đi, danh mục mẫu tin, chiến dịch chăm sóc
  src/worker/        lịch chạy của tiến trình worker (src/worker.ts)
  src/subscription/  gói dịch vụ nhìn từ phía phòng tập (tình trạng, hạn mức, hoá đơn)
  src/platform/      quản trị nền tảng: PlatformDb (cửa duy nhất, ghi nhật ký), đối soát
  src/webhook/       webhook từ bên ngoài (SePay, báo phát Zalo) — @Public, tự xác thực bằng khoá
  src/sms/           SMS dự phòng cho OTP (driver log | off)
  test/              cổng gác (cách ly, kỷ luật CSDL, khoá Redis, đối soát) + test nghiệp vụ
apps/web/            Next.js App Router, Server Component gọi API bằng cookie httpOnly
packages/contracts/  zod DTO + type CSDL, dùng chung hai đầu
db/migrations/       SQL viết tay, chạy tuần tự
db/demote-migrator.ts  tách pt_migrator khỏi superuser (máy dựng trước 30/09/2026)
db/restore-tenant.ts   khôi phục MỘT phòng từ bản sao lưu
db/backup.ts           dịch vụ sao lưu: dump, mã hoá, S3, xoay vòng, khôi phục thử
scripts/loadtest/    dữ liệu + kịch bản kiểm thử tải (không phụ thuộc gói nào)
```

---

## Còn phải làm

Theo thứ tự, vì mỗi bước dựa vào bước trước:

| Phase | Nội dung |
| --- | --- |
| ~~1~~ | ~~Đăng nhập OTP, CRUD PT, gói tập, upload S3 presigned~~ — xong 29/09/2026 |
| ~~2~~ | ~~Bán gói, hoá đơn trả góp, thu tiền, hoa hồng `SALE`~~ — xong 29/09/2026 |
| ~~3~~ | ~~Lịch tập, điểm danh QR, hoa hồng `TEACH`, `revenue_entry`~~ — xong 29/09/2026 |
| ~~4~~ | ~~Báo cáo doanh số, bảng lương PT, materialized view~~ — xong 29/09/2026 |
| ~~5~~ | ~~Web cho hội viên (`/me`)~~ — xong 29/09/2026 |
| ~~6~~ | ~~Zalo OA theo từng phòng, outbox worker, chiến dịch chăm sóc~~ — xong 29/09/2026 |
| ~~7~~ | ~~Hạn mức gói SaaS, quản trị nền tảng, đối soát thu tiền thủ công~~ — xong 29/09/2026 |
| ~~8~~ | ~~Vận hành: quét buổi tập, tự phân bổ trả góp, mở lại bảng lương, đối soát định kỳ~~ — xong 29/09/2026 |
| ~~9~~ | ~~Màn thêm/sửa (hội viên, PT, gói, bán gói, thu/hoàn/huỷ), hội viên tự đặt & đổi lịch, hoá đơn PDF, màn bảng lương~~ — xong 30/09/2026 |
| ~~10~~ | ~~Báo phát ZNS, SMS dự phòng cho OTP, kiểm thử tải, tách `pt_migrator` khỏi superuser, khôi phục một phòng~~ — xong 30/09/2026 |
| ~~11~~ | ~~Sao lưu tự động: hằng đêm + trước migration, mã hoá lên S3, xoay vòng, khôi phục thử định kỳ, cảnh báo webhook~~ — xong 30/09/2026 |

### Chưa làm, biết là chưa làm

- **Tích hợp Zalo CHƯA chạy với OA thật.** Mọi luồng đã chạy đầu-cuối bằng driver
  `log`; endpoint và mã lỗi của Zalo viết theo tài liệu công khai, để cấu hình
  được (`ZALO_OAUTH_BASE`, `ZALO_ZNS_URL`). Trước khi bật cho khách: kết nối một
  OA thật, gửi ZNS ở `ZALO_ZNS_DEV_MODE=1`, đối chiếu mã lỗi token trong
  `zalo-api.ts`.
- **Báo phát ZNS chưa thử với sự kiện thật của Zalo.** Công thức chữ ký và tên sự
  kiện theo tài liệu công khai. Lệch thì mọi sự kiện trả 401 `INVALID_SIGNATURE`
  (xem log api) và cột "đã nhận" trống — tin vẫn gửi bình thường.
- **SMS chưa nối nhà cung cấp thật.** Mới có driver `log`/`off`; ở production
  mặc định `off`, tức OTP vẫn chỉ đi được qua Zalo cho tới khi cắm nhà cung cấp
  (brandname phải đăng ký với nhà mạng) vào `sms/sms-api.ts`.
- **Không có cổng thanh toán thẻ / ví.** Tự khớp chỉ qua webhook SePay (chuyển
  khoản ngân hàng); chưa chạy với tài khoản SePay thật — kiểm bằng payload mẫu
  theo tài liệu công khai của SePay.
- **Đổi gói giữa kỳ không tính chênh lệch (prorate).** Giá mới áp từ kỳ sau.
- **Mật khẩu tạm vẫn do người tạo tự gửi** (chủ phòng mới, quản trị viên mới) —
  chưa gửi tự động qua Zalo/SMS. Đã bắt đổi ở lần đăng nhập đầu, nên lộ ra sau
  đó cũng hết giá trị.
- **Kiểm thử tải mới đo trên máy dev.** Chưa đo máy thật từ một máy khác.
- **Sao lưu tự động chưa chạy trên máy chủ thật / S3 CMC thật.** Đã kiểm với
  CSDL dev và một S3 giả lập; lần deploy tới sẽ bật nó. Sau đó cần xem
  `backups/status.json` có `lastS3Key` và một lần khôi phục thử `OK`.
- **Chưa đặt kênh cảnh báo sao lưu.** `BACKUP_ALERT_WEBHOOK` (lỗi) và
  `BACKUP_HEARTBEAT_URL` (im lặng — container chết hẳn) đều trống: tới khi điền,
  sao lưu hỏng chỉ lộ ra ở healthcheck và ở lần deploy sau.
- **Khôi phục một phòng không khôi phục tệp S3.** Tệp bị xoá sau ngày sao lưu
  (ảnh tiến độ, logo) thì dòng `file_object` về nhưng tệp không còn.
