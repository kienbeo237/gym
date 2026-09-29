-- =============================================================================
-- 0011 — Phase 3: điểm danh, ghi nhận doanh thu theo buổi, hoa hồng dạy.
--
-- Đây là chỗ BA con số doanh thu gặp nhau lần đầu:
--   payment.signed_amount   — tiền THU (đã có từ phase 2)
--   revenue_entry.amount    — doanh thu GHI NHẬN (phase này)
--   commission_entry        — hoa hồng, nay đủ cả SALE lẫn TEACH
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Buổi tập bị tiêu thụ vì LÝ DO GÌ.
--
-- Ba lý do đều trừ một buổi và đều ghi nhận doanh thu (phòng tập đã bán chỗ
-- đó), nhưng chỉ CHECKIN mới trả hoa hồng dạy — hai lý do kia không có buổi
-- dạy nào diễn ra. Không có cột này thì báo cáo không phân biệt được
-- "1.200 buổi đã dạy" với "1.200 buổi đã trừ", hai con số rất khác nhau khi
-- nói chuyện với huấn luyện viên.
-- ---------------------------------------------------------------------------
ALTER TABLE revenue_entry
  ADD COLUMN source text NOT NULL DEFAULT 'CHECKIN'
    CHECK (source IN ('CHECKIN', 'NO_SHOW', 'LATE_CANCEL'));

-- ---------------------------------------------------------------------------
-- 2. Mã QR điểm danh dùng MỘT LẦN.
--
-- Bảng checkin_token đã có từ 0002 nhưng chưa có ràng buộc này: thiếu nó thì
-- chụp màn hình mã QR rồi gửi cho người khác vẫn dùng được nhiều lần trong
-- khung 60 giây, và cả phòng tập điểm danh bằng một ảnh chụp.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX uq_checkin_token_open ON checkin_token (booking_id)
  WHERE used_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Đối soát doanh thu: mỗi buổi TIÊU THỤ phải có đúng một dòng doanh thu.
--
-- Thiếu dòng = phòng tập dạy không công mà báo cáo không biết.
-- Thừa dòng = doanh thu bị đếm hai lần.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_revenue_drift AS
SELECT b.tenant_id,
       b.id            AS booking_id,
       b.status,
       b.deducted,
       count(re.id)    AS so_dong_doanh_thu
FROM booking b
LEFT JOIN revenue_entry re ON re.booking_id = b.id
WHERE b.deducted                      -- chỉ buổi ĐÃ TRỪ mới sinh doanh thu
GROUP BY b.tenant_id, b.id, b.status, b.deducted
HAVING count(re.id) <> 1;

-- ---------------------------------------------------------------------------
-- 4. Đối soát hoa hồng dạy: mỗi buổi ĐÃ DẠY (CHECKIN) phải có đúng một dòng.
--
-- Buổi vắng mặt / huỷ muộn KHÔNG sinh hoa hồng dạy, nên loại khỏi phép kiểm
-- bằng chính `revenue_entry.source` chứ không bằng trạng thái booking —
-- trạng thái còn đổi được về sau, còn lý do tiêu thụ thì không.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_teach_commission_drift AS
SELECT re.tenant_id,
       re.booking_id,
       re.trainer_id,
       re.amount       AS doanh_thu,
       count(ce.id)    AS so_dong_hoa_hong
FROM revenue_entry re
LEFT JOIN commission_entry ce
       ON ce.booking_id = re.booking_id AND ce.kind = 'TEACH'
WHERE re.source = 'CHECKIN'
GROUP BY re.tenant_id, re.booking_id, re.trainer_id, re.amount
HAVING count(ce.id) <> 1;

-- ---------------------------------------------------------------------------
-- 5. Đối soát tổng doanh thu ghi nhận không vượt số tiền của hợp đồng.
--
-- Buổi tặng thêm (BONUS) vượt quá `sessions_total` phải ghi doanh thu 0 —
-- hội viên không trả tiền cho chúng. Không gác thì tổng doanh thu của một hợp
-- đồng vượt giá bán, và báo cáo lãi ảo.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_revenue_over_contract AS
SELECT mp.tenant_id,
       mp.id   AS member_package_id,
       mp.code,
       mp.price_net,
       COALESCE(SUM(re.amount), 0) AS da_ghi_nhan
FROM member_package mp
LEFT JOIN revenue_entry re ON re.member_package_id = mp.id
GROUP BY mp.tenant_id, mp.id, mp.code, mp.price_net
HAVING COALESCE(SUM(re.amount), 0) > mp.price_net;

-- ---------------------------------------------------------------------------
-- 6. Chỉ mục cho màn LỊCH: quét theo khoảng thời gian của cả phòng tập.
--
-- ix_booking_trainer_time (0002) chỉ phục vụ lịch của MỘT huấn luyện viên;
-- màn lịch tuần đọc mọi buổi trong khoảng ngày nên cần chỉ mục theo thời gian.
-- ---------------------------------------------------------------------------
CREATE INDEX ix_booking_calendar ON booking (tenant_id, starts_at)
  WHERE status IN ('BOOKED', 'CHECKED_IN', 'COMPLETED');
