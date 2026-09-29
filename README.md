# PT — Quản lý hội viên phòng tập cá nhân (SaaS đa phòng)

PostgreSQL · NestJS · Next.js · S3 · Redis. Một cài đặt phục vụ nhiều phòng tập,
cách ly dữ liệu ở tầng cơ sở dữ liệu.

**Trạng thái: Phase 0 xong** — nền multi-tenant, xác thực hai bước, một lát cắt
nghiệp vụ chạy thật (hội viên) và bốn cổng gác tự động. Xem [Còn phải làm](#còn-phải-làm).

---

## Chạy lần đầu

```bash
cp .env.example .env          # sửa secret trước khi lên môi trường thật
pnpm install
pnpm infra:up                 # postgres + redis + s3, đợi healthy
pnpm db:migrate
pnpm db:seed                  # 2 phòng tập mẫu, mỗi phòng 5 hội viên + 2 PT
pnpm dev                      # api :4000, web :3000
```

Đăng nhập: `+84901000001` / `Matkhau@123` (chủ phòng Alpha) hoặc `+84902000001`
(chủ phòng Beta). Hai tài khoản thấy hai tập dữ liệu hoàn toàn khác nhau — đó là
phép thử nhanh nhất xem cách ly còn hoạt động.

| Thành phần | Cổng | Ghi chú |
| --- | --- | --- |
| Web (Next.js) | 3000 | |
| API (NestJS) | 4000 | tiền tố `/api` |
| PostgreSQL | **55432** | lệch chuẩn để không đụng dự án khác trên cùng máy |
| Redis | **56379** | |
| S3 (LocalStack) | **59000** | bucket `pt-private` |

**LocalStack thay MinIO là lựa chọn của môi trường dev, không phải của kiến trúc.**
Ảnh `minio/minio` không kéo được từ mạng nội bộ (Docker Hub và quay.io đều trả 401,
đo 29/09/2026), và `localstack/localstack:stable` đã bị gated license — nên ghim
`localstack/localstack:4`. API S3 giống nhau nên mã nguồn không đổi; môi trường
thật dùng S3 của AWS hoặc MinIO cài trên máy chủ.

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
pnpm --filter @pt/api test     # 20 phép kiểm
```

| Nhóm | Bắt lớp lỗi |
| --- | --- |
| A. Cấu trúc | bảng mới có `tenant_id` mà quên gọi `enable_tenant_rls()` |
| B. Đặc quyền | role app bị cấp `SUPERUSER`/`BYPASSRLS` khi dựng môi trường |
| C. Khoá | `UNIQUE` thiếu `tenant_id` |
| D. Hành vi | đọc/ghi chéo tenant, bằng **chính role app_rw** |
| + Kỷ luật | tiêm `DB_PLATFORM` vào service nghiệp vụ, hoặc dùng `SET` thay `set_config` |

Hai nhóm có **test âm** chống tautology: chúng tự tạo một vi phạm giả lập và đòi
bộ nhận diện bắt được. Không có test âm thì một truy vấn luôn trả rỗng cũng làm
mọi thứ xanh, và cổng gác thành trang trí.

### Ba role, ba mức quyền

| Role | `BYPASSRLS` | Dùng ở đâu |
| --- | --- | --- |
| `app_rw` | **không** | mọi nghiệp vụ, qua `TenantDb` |
| `app_auth` | có, quyền hẹp | chỉ luồng đăng nhập (chạy trước khi có tenant) |
| `app_platform` | có | quản trị nền tảng; mọi thao tác ghi `platform_audit_log` |

`app_rw` bị thu hồi quyền trên `otp_challenge`, `refresh_token`,
`platform_audit_log` — những bảng đó **không có RLS**, nên quyền thừa là quyền rò.

---

## Những quyết định không hiển nhiên

### Sổ cái buổi tập, không phải cột `remaining`

`session_ledger` chỉ ghi thêm (`delta` ±1), `member_package.sessions_used` là bản
cache ghi trong **cùng transaction**. Cột tự trừ là nguồn của mọi tranh chấp với
khách ("em tập 8 buổi sao trừ 10?") và không hoàn tác được khi huỷ điểm danh nhầm.

Đối soát hằng đêm qua view `v_session_balance_drift`. **Lệch thì cảnh báo, không
tự sửa** — tự sửa là giấu mất nguyên nhân.

Chống trừ hai lần: `uq_ledger_checkin` là partial unique index trên
`(ref_type, ref_id)` — hai thiết bị bấm cùng lúc thì một cái vỡ ở tầng DB, đúng
như mong muốn.

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
token bị đánh cắp, hệ thống thu hồi **cả họ**.

### Chính sách huỷ / vắng mặt

Phòng đặt mặc định ở `tenant_policy`, gói ghi đè từng ô ở `package_template`
(cột `NULL` = theo phòng). Phân giải bằng **một hàm duy nhất**
`resolve_booking_policy()` — ba chỗ `COALESCE` rải rác là ba cơ hội để chúng trôi
khỏi nhau.

### Múi giờ

Lưu `timestamptz`, gộp báo cáo bằng `AT TIME ZONE 'Asia/Ho_Chi_Minh'`. Buổi 6h
sáng ngày 1 theo giờ VN là 23h ngày 30 theo UTC — gộp theo UTC là lệch đúng những
ngày đầu/cuối tháng, và không ai phát hiện cho tới lúc chốt lương.

### Tiền

`bigint`, đơn vị **đồng**. Không có số thực ở bất cứ đâu chạm tới tiền.

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
  src/auth/          đăng nhập hai bước, refresh xoay vòng
  src/member/        lát cắt nghiệp vụ mẫu — đọc nó trước khi viết module mới
  test/              cổng gác cách ly + kỷ luật truy cập
apps/web/            Next.js App Router, Server Component gọi API bằng cookie httpOnly
packages/contracts/  zod DTO + type CSDL, dùng chung hai đầu
db/migrations/       SQL viết tay, chạy tuần tự
```

---

## Còn phải làm

Theo thứ tự, vì mỗi bước dựa vào bước trước:

| Phase | Nội dung |
| --- | --- |
| 1 | Đăng nhập OTP (hạ tầng `otp_challenge` đã có), CRUD PT, gói tập, upload S3 presigned |
| 2 | Bán gói, hoá đơn trả góp, thu tiền, hoa hồng `SALE` |
| 3 | Lịch tập, điểm danh QR, hoa hồng `TEACH`, `revenue_entry` |
| 4 | Báo cáo doanh số, bảng lương PT, materialized view |
| 5 | Web cho hội viên (`/me`) |
| 6 | Zalo OA theo từng phòng, outbox worker, chiến dịch chăm sóc |
| 7 | Hạn mức gói SaaS, quản trị nền tảng, đối soát thu tiền thủ công |

### Chưa làm, biết là chưa làm

- **Redis mới chỉ chạy, chưa dùng.** BullMQ, cache, khoá phân tán đều thuộc phase
  sau. Khi thêm: 3 hàng đợi theo **độ trễ** (`realtime`/`bulk`/`scheduled`), không
  phải theo tenant — 200 phòng × 3 hàng đợi là 600 hàng đợi và Redis sập vì số
  lượng chứ không vì tải. Mọi khoá cache bắt buộc có tiền tố `t:{tenantId}:`.
- **Chưa có worker Zalo.** Khi làm: ghi `notification_outbox` **trong** transaction
  nghiệp vụ, gửi ở tiến trình khác. Gọi HTTP trong transaction thì mạng chậm sẽ
  giữ khoá trên `member_package` và kéo sập cả luồng điểm danh. Token OA xoay vòng
  nên **bắt buộc** có khoá phân tán quanh bước refresh: hai worker cùng refresh thì
  một cái nhận token chết và toàn bộ tin nhắn của phòng đó ngừng gửi, không lỗi rõ
  ràng.
- **Chưa có kiểm thử tải.** Tập nghĩa vụ lớn nhất là `booking` × số hội viên;
  chưa đo với dữ liệu thật.
- **`pt_migrator` đang là SUPERUSER** vì ảnh Docker của Postgres đặt vậy. Môi
  trường thật phải tách chủ-sở-hữu-schema khỏi superuser — nếu không, một lỗi cấu
  hình khiến API dùng nhầm kết nối đó sẽ vô hiệu hoá RLS mà cổng gác B không bắt
  được (nó chỉ kiểm `app_rw`).
- **Khôi phục dữ liệu một phòng từ backup là thao tác thủ công.** Shared schema
  nên `pg_restore` là all-or-nothing. Cần kịch bản viết sẵn trước khi có khách thật.
