-- =============================================================================
-- 0010 — Tách "SỐ DƯ" khỏi "SỐ BUỔI ĐÃ DÙNG".
--
-- Phát hiện bằng chính view đối soát của 0003, trên dữ liệu thật: hợp đồng bị
-- huỷ (mua +10, hoàn -10) báo lệch -10 trong khi CẢ HAI con số đều đúng —
-- số dư 0, đã dùng 0. Sai nằm ở công thức đối soát, nó trộn hai đại lượng:
--
--   SỐ DƯ      = SUM(delta) trên MỌI dòng sổ cái. Đây là thứ gác việc điểm
--                danh: hết số dư thì không tập được nữa.
--   ĐÃ DÙNG    = số buổi TIÊU THỤ (điểm danh, vắng mặt bị trừ). Đây là con số
--                nghiệp vụ trên báo cáo.
--
-- Hai đại lượng này BẰNG NHAU trong ca thường (`total - used = remaining`) nên
-- dễ tưởng là một. Chúng tách nhau ở đúng ba chỗ, và cả ba đều là chuyện thật:
-- huỷ hợp đồng, tặng thêm buổi (BONUS), chuyển buổi sang gói khác.
--
-- Hệ quả đã có trong mã: `MemberService.list` tính buổi còn lại bằng
-- `sessions_total - sessions_used`, nên một dòng BONUS +5 sẽ KHÔNG hiện ra —
-- hội viên được tặng buổi mà màn hình vẫn báo số cũ.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Số dư thành cột riêng, do TRIGGER giữ.
--
-- Không tính bằng SUM(delta) mỗi lần đọc: danh sách hội viên sẽ phải quét sổ
-- cái cho từng dòng. Không để service tự cập nhật: sổ cái được ghi từ bán gói,
-- điểm danh, huỷ, tặng buổi, chuyển buổi — mỗi đường là một cơ hội quên.
-- ---------------------------------------------------------------------------
ALTER TABLE member_package
  ADD COLUMN sessions_remaining int NOT NULL DEFAULT 0;

UPDATE member_package mp
   SET sessions_remaining = COALESCE(
     (SELECT SUM(sl.delta) FROM session_ledger sl WHERE sl.member_package_id = mp.id), 0);

ALTER TABLE member_package
  ADD CONSTRAINT mp_remaining_nonneg CHECK (sessions_remaining >= 0);

CREATE OR REPLACE FUNCTION sync_session_remaining() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_pkg uuid := COALESCE(NEW.member_package_id, OLD.member_package_id);
BEGIN
  UPDATE member_package
     SET sessions_remaining = COALESCE(
       (SELECT SUM(sl.delta) FROM session_ledger sl WHERE sl.member_package_id = v_pkg), 0)
   WHERE id = v_pkg;
  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_sync_session_remaining
  AFTER INSERT OR UPDATE OR DELETE ON session_ledger
  FOR EACH ROW EXECUTE FUNCTION sync_session_remaining();

COMMENT ON COLUMN member_package.sessions_remaining IS
  'SỐ DƯ buổi tập = SUM(session_ledger.delta). Do trigger giữ, đừng ghi tay.';
COMMENT ON COLUMN member_package.sessions_used IS
  'Số buổi ĐÃ TIÊU THỤ (điểm danh/vắng). KHÁC với sessions_total - sessions_remaining
   khi hợp đồng bị huỷ hoặc được tặng thêm buổi.';

-- ---------------------------------------------------------------------------
-- 2. Đối soát lại cho đúng: so ĐÃ DÙNG với các dòng TIÊU THỤ của sổ cái.
--    `REVOKE_CHECKIN` mang delta dương nên tự trừ ngược khỏi số đã dùng.
--
-- DROP trước: `CREATE OR REPLACE VIEW` chỉ thay được thân truy vấn, không đổi
-- được tên hay thứ tự cột — và ở đây cột đổi hẳn.
-- ---------------------------------------------------------------------------
DROP VIEW IF EXISTS v_session_balance_drift;
CREATE VIEW v_session_balance_drift AS
SELECT mp.tenant_id,
       mp.id   AS member_package_id,
       mp.code,
       mp.sessions_total,
       mp.sessions_used      AS cached_used,
       COALESCE(-SUM(sl.delta) FILTER (
         WHERE sl.reason IN ('CHECKIN', 'NO_SHOW', 'LATE_CANCEL', 'REVOKE_CHECKIN')), 0)
                             AS ledger_used,
       mp.sessions_remaining AS cached_remaining,
       COALESCE(SUM(sl.delta), 0) AS ledger_remaining
FROM member_package mp
LEFT JOIN session_ledger sl ON sl.member_package_id = mp.id
GROUP BY mp.tenant_id, mp.id, mp.code, mp.sessions_total, mp.sessions_used, mp.sessions_remaining
HAVING mp.sessions_used <> COALESCE(-SUM(sl.delta) FILTER (
         WHERE sl.reason IN ('CHECKIN', 'NO_SHOW', 'LATE_CANCEL', 'REVOKE_CHECKIN')), 0)
    OR mp.sessions_remaining <> COALESCE(SUM(sl.delta), 0);

-- ---------------------------------------------------------------------------
-- 3. Việc phải xử lý: lần thu tiền không phân giải được chính sách hoa hồng.
--
-- Khi đó `accrueForPayment` vẫn ghi một dòng 0 đồng có cờ `missing` — cố ý
-- KHÔNG chặn việc thu tiền vì một lỗ hổng cấu hình, tiền đã vào két rồi. Nhưng
-- phải có chỗ nhặt lên, nếu không đó là tiền nợ PT mà không ai biết.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_commission_needs_policy AS
SELECT ce.tenant_id,
       ce.id          AS commission_entry_id,
       ce.trainer_id,
       ce.payment_id,
       ce.base_amount,
       ce.earned_at,
       ce.policy_snapshot ->> 'resolvedOn' AS resolved_on
FROM commission_entry ce
WHERE ce.policy_snapshot ->> 'missing' = 'true';
