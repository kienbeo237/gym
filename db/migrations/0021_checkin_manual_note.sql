-- 0021: điểm danh HỘ (không mã QR) phải có lý do.
--
-- Mã QR là chốt kiểm soát duy nhất giữa "HLV bấm đã dạy" và "hoa hồng dạy
-- được ghi". Đường PT_CONFIRM / ADMIN bỏ qua chốt đó cho ca có thật (hội viên
-- quên điện thoại, hỏng camera) — nên nó phải để lại dấu vết đọc được: ai bấm
-- (checkin_by, đã có), vì sao (cột này), và hội viên thấy dòng đó trong lịch
-- sử của mình (note của session_ledger, ghi cùng transaction).
--
-- Ràng buộc đặt ở CSDL chứ không chỉ ở API: API là một lối vào, script vận
-- hành và SQL tay là lối khác.

ALTER TABLE booking ADD COLUMN checkin_note text;

-- Dòng cũ (nếu có) không có lý do để khôi phục; ghi rõ là không có thay vì
-- để ràng buộc NOT VALID mãi mãi.
UPDATE booking
   SET checkin_note = 'Không ghi lý do (điểm danh trước 30/09/2026)'
 WHERE checkin_method IN ('PT_CONFIRM', 'ADMIN') AND checkin_note IS NULL;

-- coalesce BẮT BUỘC: CHECK coi NULL là QUA, và length(btrim(NULL)) >= 5 là
-- NULL — viết thiếu thì chính ca cần chặn (không có lý do) lại lọt.
ALTER TABLE booking ADD CONSTRAINT booking_manual_checkin_note CHECK (
  checkin_method IS NULL
  OR checkin_method NOT IN ('PT_CONFIRM', 'ADMIN')
  OR coalesce(length(btrim(checkin_note)), 0) >= 5
);
