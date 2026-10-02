-- 0022: TẶNG BUỔI cho hội viên.
--
-- Sổ cái đã có lý do 'BONUS' từ đầu (0002) nhưng chưa đường nào ghi được, vì
-- mp_sessions_range (sessions_used <= sessions_total) sẽ làm ĐIỂM DANH vỡ đúng
-- lúc hội viên dùng tới buổi được tặng. Nới ràng buộc đó, nhưng không bỏ: buổi
-- đã dùng vẫn không được vượt số buổi mua + số buổi tặng.
--
-- Doanh thu không phải sửa: đơn giá buổi tính theo sessions_total (số buổi
-- MUA), buổi vượt quá ghi nhận 0 đồng (SessionConsumptionService.donGiaBuoi).

ALTER TABLE member_package
  ADD COLUMN sessions_bonus int NOT NULL DEFAULT 0 CHECK (sessions_bonus >= 0);

COMMENT ON COLUMN member_package.sessions_bonus IS
  'Tổng buổi được TẶNG = SUM(session_ledger.delta) với reason BONUS. Do trigger giữ, đừng ghi tay.';

-- Trigger sẵn có giữ sessions_remaining; giữ luôn sessions_bonus ở cùng chỗ —
-- không để service tự cộng (một đường quên là số liệu lệch).
CREATE OR REPLACE FUNCTION sync_session_remaining() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_pkg uuid := COALESCE(NEW.member_package_id, OLD.member_package_id);
BEGIN
  UPDATE member_package
     SET sessions_remaining = COALESCE(
           (SELECT SUM(sl.delta) FROM session_ledger sl WHERE sl.member_package_id = v_pkg), 0),
         sessions_bonus = COALESCE(
           (SELECT SUM(sl.delta) FROM session_ledger sl
             WHERE sl.member_package_id = v_pkg AND sl.reason = 'BONUS'), 0)
   WHERE id = v_pkg;
  RETURN NULL;
END $fn$;

UPDATE member_package mp
   SET sessions_bonus = COALESCE(
     (SELECT SUM(sl.delta) FROM session_ledger sl
       WHERE sl.member_package_id = mp.id AND sl.reason = 'BONUS'), 0);

ALTER TABLE member_package DROP CONSTRAINT mp_sessions_range;
ALTER TABLE member_package ADD CONSTRAINT mp_sessions_range
  CHECK (sessions_used BETWEEN 0 AND sessions_total + sessions_bonus);

-- Tặng buổi là cho đi thứ có giá: phải có người tặng và lý do đọc được — ở
-- CSDL, không chỉ ở API (SQL tay cũng là một lối vào). Cùng lý do với 0021.
ALTER TABLE session_ledger ADD CONSTRAINT ledger_bonus_accountable CHECK (
  reason <> 'BONUS'
  OR (delta > 0 AND created_by IS NOT NULL AND coalesce(length(btrim(note)), 0) >= 5)
) NOT VALID;
ALTER TABLE session_ledger VALIDATE CONSTRAINT ledger_bonus_accountable;
