-- =============================================================================
-- 0009 — Phase 2: bán gói, hoá đơn trả góp, thu tiền, hoa hồng bán hàng.
--
-- Nguyên tắc chung của file này: mọi bất biến về TIỀN đặt ở CSDL, không đặt ở
-- service. Lý do không phải "cho chắc" mà rất cụ thể — tiền được ghi từ nhiều
-- đường (bán gói, thu đợt, hoàn tiền, huỷ hoá đơn, và phase sau còn thêm), và
-- mỗi đường là một cơ hội quên. Trigger thì không quên được.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Hoa hồng phải ÂM ĐƯỢC.
--
-- Hoàn tiền sinh một dòng hoa hồng ĐẢO, không sửa dòng cũ: bảng lương tháng
-- trước đã chốt phải đọc lại được y nguyên. Dòng đảo mang số âm và rơi vào kỳ
-- lương của tháng hoàn tiền — đúng cách kế toán làm.
-- ---------------------------------------------------------------------------
ALTER TABLE commission_entry
  DROP CONSTRAINT commission_entry_amount_check,
  DROP CONSTRAINT commission_entry_base_amount_check;

COMMENT ON COLUMN commission_entry.amount IS
  'VND. ÂM = bút toán đảo khi hoàn tiền. Không bao giờ sửa dòng cũ.';

-- ---------------------------------------------------------------------------
-- 2. Chống ghi trùng một lần thu.
--
-- Bấm hai lần nút "Đã thu" là hai dòng payment, và khách bị ghi nhận trả gấp
-- đôi. Không có cách nào phát hiện sau đó ngoài đối soát thủ công.
-- ---------------------------------------------------------------------------
ALTER TABLE payment ADD COLUMN idempotency_key text;
CREATE UNIQUE INDEX uq_payment_idem ON payment (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. invoice.paid_amount và invoice.status LUÔN khớp các dòng thu.
--
-- Trước đây hai cột này do service tự cập nhật. Đặt ở trigger thì mọi đường
-- ghi payment — kể cả đường viết sau này, kể cả lệnh SQL chạy tay để sửa dữ
-- liệu — đều giữ đúng bất biến.
--
-- View v_invoice_paid_drift (0003) trở thành lớp kiểm tra thứ hai chứ không
-- còn là lớp duy nhất.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_invoice_paid() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_invoice  uuid   := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_schedule uuid   := COALESCE(NEW.schedule_id, OLD.schedule_id);
  v_paid     bigint;
  v_refunded boolean;
BEGIN
  SELECT COALESCE(SUM(signed_amount), 0),
         COALESCE(bool_or(kind = 'REFUND'), false)
    INTO v_paid, v_refunded
  FROM payment WHERE invoice_id = v_invoice;

  UPDATE invoice i
     SET paid_amount = v_paid,
         status = CASE
           -- DRAFT và VOID là quyết định của con người, trigger không đụng vào.
           WHEN i.status IN ('DRAFT', 'VOID')            THEN i.status
           WHEN v_paid <= 0 AND v_refunded                THEN 'REFUNDED'
           WHEN v_paid <= 0                               THEN 'OPEN'
           WHEN v_paid >= i.total_amount                  THEN 'PAID'
           ELSE 'PARTIALLY_PAID'
         END
   WHERE i.id = v_invoice;

  -- Đợt trả góp tương ứng: đủ tiền thì đóng, quá hạn mà chưa đủ thì báo quá hạn.
  IF v_schedule IS NOT NULL THEN
    UPDATE payment_schedule ps
       SET status = CASE
             WHEN (SELECT COALESCE(SUM(p.signed_amount), 0)
                     FROM payment p WHERE p.schedule_id = ps.id) >= ps.amount THEN 'PAID'
             WHEN ps.due_date < current_date                                  THEN 'OVERDUE'
             ELSE 'DUE'
           END
     WHERE ps.id = v_schedule AND ps.status <> 'WAIVED';
  END IF;

  RETURN NULL;
END $fn$;

CREATE TRIGGER trg_sync_invoice_paid
  AFTER INSERT OR UPDATE OR DELETE ON payment
  FOR EACH ROW EXECUTE FUNCTION sync_invoice_paid();

-- ---------------------------------------------------------------------------
-- 4. Tổng các đợt trả góp phải BẰNG tổng hoá đơn.
--
-- Kiểm theo TỪNG DÒNG thì không thể đúng: chèn đợt đầu tiên xong là tổng đã
-- lệch. Phải là CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED để phép
-- kiểm chạy lúc COMMIT, khi cả bộ đợt đã được ghi xong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_installment_total() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_invoice uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_total   bigint;
  v_inst    boolean;
  v_sum     bigint;
BEGIN
  SELECT total_amount, is_installment INTO v_total, v_inst
  FROM invoice WHERE id = v_invoice;

  -- Hoá đơn đã bị xoá trong cùng giao dịch, hoặc không phải trả góp.
  IF v_total IS NULL OR NOT v_inst THEN RETURN NULL; END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_sum
  FROM payment_schedule WHERE invoice_id = v_invoice;

  IF v_sum <> v_total THEN
    RAISE EXCEPTION 'INSTALLMENT_TOTAL_MISMATCH:%:%', v_sum, v_total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$;

CREATE CONSTRAINT TRIGGER trg_installment_total
  AFTER INSERT OR UPDATE OR DELETE ON payment_schedule
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_installment_total();

-- ---------------------------------------------------------------------------
-- 5. Phân giải chính sách hoa hồng — MỘT nguồn duy nhất.
--
-- Bốn mức cụ thể, thứ tự cố định:
--     (PT, gói)  >  (PT, mọi gói)  >  (mọi PT, gói)  >  (mọi PT, mọi gói)
--
-- Vì sao PT thắng GÓI: hoa hồng là điều khoản trong thoả thuận với NGƯỜI đó
-- (PT senior ăn cao hơn), còn tỷ lệ theo gói chỉ là mặc định của bảng giá.
-- Đảo lại thì một gói khuyến mãi sẽ âm thầm hạ hoa hồng của PT senior, và
-- không ai phát hiện cho tới kỳ lương.
--
-- Hàm trả về 0 dòng khi không có chính sách nào — bên gọi phải xử lý, KHÔNG
-- mặc định 0%: im lặng trả 0 là quỵt lương mà không báo lỗi ở đâu.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_commission_policy(
  p_tenant   uuid,
  p_trainer  uuid,
  p_template uuid,
  p_on       date
) RETURNS TABLE (
  policy_id          uuid,
  sale_pct           numeric,
  teach_mode         text,
  teach_fixed_amount bigint,
  teach_pct          numeric,
  specificity        int
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT cp.id, cp.sale_pct, cp.teach_mode, cp.teach_fixed_amount, cp.teach_pct,
         (CASE WHEN cp.trainer_id          IS NOT NULL THEN 2 ELSE 0 END)
       + (CASE WHEN cp.package_template_id IS NOT NULL THEN 1 ELSE 0 END)
  FROM commission_policy cp
  WHERE cp.tenant_id = p_tenant
    AND (cp.trainer_id          IS NULL OR cp.trainer_id          = p_trainer)
    AND (cp.package_template_id IS NULL OR cp.package_template_id = p_template)
    AND cp.effective_from <= p_on
    AND (cp.effective_to IS NULL OR cp.effective_to >= p_on)
  ORDER BY 6 DESC, cp.effective_from DESC
  LIMIT 1;
$fn$;

REVOKE ALL ON FUNCTION resolve_commission_policy(uuid, uuid, uuid, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_commission_policy(uuid, uuid, uuid, date) TO app_rw;

-- ---------------------------------------------------------------------------
-- 6. Đối soát hoa hồng bán hàng: mỗi lần thu phải có đúng một dòng hoa hồng
--    (hoặc không dòng nào, nếu hợp đồng không gắn PT bán).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sale_commission_drift AS
SELECT p.tenant_id,
       p.id            AS payment_id,
       p.invoice_id,
       p.signed_amount,
       mp.sold_by_id,
       count(ce.id)    AS so_dong_hoa_hong
FROM payment p
JOIN invoice_item ii   ON ii.invoice_id = p.invoice_id
JOIN member_package mp ON mp.id = ii.member_package_id
LEFT JOIN commission_entry ce
       ON ce.payment_id = p.id AND ce.kind = 'SALE'
WHERE mp.sold_by_id IS NOT NULL
GROUP BY p.tenant_id, p.id, p.invoice_id, p.signed_amount, mp.sold_by_id
HAVING count(ce.id) <> 1;

-- ---------------------------------------------------------------------------
-- 7. Chỉ mục phục vụ màn công nợ và nhắc hạn đợt trả góp.
-- ---------------------------------------------------------------------------
CREATE INDEX ix_invoice_debt ON invoice (tenant_id, member_id)
  WHERE status IN ('OPEN', 'PARTIALLY_PAID');
