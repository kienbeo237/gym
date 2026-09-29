-- =============================================================================
-- 0008 — Phase 1: tải tệp hai bước, khung giờ PT không chồng nhau, thứ tự hiển
--        thị gói tập.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Tải tệp lên S3 là quy trình HAI BƯỚC, nên file_object phải có trạng thái.
--
--   1. API ký URL và ghi dòng PENDING   (chưa có tệp nào trên S3)
--   2. Trình duyệt PUT thẳng lên S3     (không đi qua API)
--   3. API xác nhận -> CONFIRMED        (đọc lại metadata từ S3, không tin client)
--
-- Không có cột này thì không phân biệt được "đang tải" với "tải hỏng giữa
-- chừng", và bucket đầy dần bằng tệp mồ côi mà không ai biết cái nào xoá được.
-- ---------------------------------------------------------------------------

ALTER TABLE file_object
  ADD COLUMN status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CONFIRMED','FAILED')),
  ADD COLUMN confirmed_at timestamptz,
  -- size/mime do client khai lúc xin URL chỉ là DỰ KIẾN; giá trị thật đọc từ
  -- S3 ở bước xác nhận. Cho phép NULL tới lúc đó.
  ALTER COLUMN size_bytes DROP NOT NULL,
  ADD CONSTRAINT file_confirmed_has_metadata CHECK (
    status <> 'CONFIRMED' OR (confirmed_at IS NOT NULL AND size_bytes IS NOT NULL)
  );

-- Dọn tệp mồ côi: dòng PENDING quá hạn thì xoá cả trên S3 lẫn trong CSDL.
CREATE INDEX ix_file_pending ON file_object (created_at) WHERE status = 'PENDING';

-- ---------------------------------------------------------------------------
-- Khung giờ nhận dạy của PT không được chồng nhau.
--
-- Cùng lý do với excl_booking_trainer_overlap ở 0002: kiểm ở tầng service thua
-- ở hai request song song.
--
-- PostgreSQL KHÔNG có sẵn range type cho `time` (chỉ int4/int8/num/ts/tstz/date),
-- nên phải tự khai. Cách còn lại là đổi giờ sang số phút rồi dùng int4range,
-- nhưng khi đó biểu thức phải lặp lại nguyên văn ở mọi nơi truy vấn — và hai
-- bản chép sẽ trôi khỏi nhau.
-- ---------------------------------------------------------------------------

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'timerange') THEN
    CREATE TYPE timerange AS RANGE (subtype = time);
  END IF;
END $do$;

ALTER TABLE trainer_availability
  ADD CONSTRAINT excl_availability_overlap
  EXCLUDE USING gist (
    tenant_id  WITH =,
    trainer_id WITH =,
    weekday    WITH =,
    timerange(start_time, end_time) WITH &&
  );

-- ---------------------------------------------------------------------------
-- Thứ tự hiển thị gói trên màn bán hàng. Không có nó thì danh sách sắp theo
-- tên và gói bán chạy nhất trôi xuống cuối.
-- ---------------------------------------------------------------------------

ALTER TABLE package_template
  ADD COLUMN sort_order int NOT NULL DEFAULT 0;

CREATE INDEX ix_pkg_template_active ON package_template (tenant_id, sort_order)
  WHERE is_active;

-- ---------------------------------------------------------------------------
-- OTP: đếm số lần gửi để chặn lạm dụng NGAY CẢ KHI Redis chết.
--
-- Giới hạn tần suất chính chạy trên Redis (nhanh, có TTL), nhưng Redis là bộ
-- nhớ tạm — mất nó là mất luôn bộ đếm, và kẻ tấn công chỉ cần chờ nó khởi động
-- lại. Chỉ mục này cho phép đếm lại từ CSDL làm lưới an toàn.
-- ---------------------------------------------------------------------------

CREATE INDEX ix_otp_rate ON otp_challenge (phone, created_at DESC);
