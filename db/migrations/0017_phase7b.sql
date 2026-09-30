-- =============================================================================
-- 0017 — Phase 7b: phần còn thiếu của gói SaaS.
--
--   1. Mật khẩu tạm phải đổi ở lần đăng nhập đầu.
--   2. Chủ phòng GỬI yêu cầu đổi gói; nền tảng duyệt. Phòng tập vẫn không tự
--      đổi được gói của mình (app_rw không ghi được tenant_subscription).
--   3. Webhook ngân hàng (SePay): khớp nội dung chuyển khoản + đúng số tiền thì
--      tự tất toán, gọi ĐÚNG saas_settle_invoice như nút bấm của người đối soát.
--      Mọi thứ khác nằm lại cho người xử lý.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Bắt đổi mật khẩu tạm.
--
-- Mật khẩu tạm đã đi qua tay người vận hành (đọc qua điện thoại, gửi Zalo):
-- ít nhất hai người biết nó. Cờ này buộc chủ sở hữu thật đặt mật khẩu chỉ mình
-- họ biết TRƯỚC khi vào được bất cứ đâu.
-- ---------------------------------------------------------------------------
ALTER TABLE identity ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Yêu cầu đổi gói.
-- ---------------------------------------------------------------------------
CREATE TABLE plan_change_request (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  from_plan     text NOT NULL REFERENCES plan(code),
  to_plan       text NOT NULL REFERENCES plan(code),
  note          text CHECK (length(note) <= 500),
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  requested_by  uuid NOT NULL REFERENCES identity(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  decided_by    uuid REFERENCES identity(id),
  decided_at    timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  CONSTRAINT pcr_changes_plan CHECK (from_plan <> to_plan),
  -- Đã xử lý thì phải biết lúc nào; còn chờ thì chưa ai xử lý.
  CONSTRAINT pcr_decided CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
-- Mỗi phòng tối đa MỘT yêu cầu đang chờ: bấm hai lần không thành hai việc cho
-- người duyệt, và không có câu hỏi "duyệt cái nào trước".
CREATE UNIQUE INDEX uq_pcr_pending ON plan_change_request (tenant_id) WHERE status = 'PENDING';
CREATE INDEX ix_pcr_open ON plan_change_request (created_at) WHERE status = 'PENDING';

SELECT enable_tenant_rls('plan_change_request');

-- Phòng tập: tạo yêu cầu, tự huỷ yêu cầu của mình. KHÔNG tự duyệt: hai policy
-- RESTRICTIVE dưới đây AND với tenant_isolation, chỉ áp cho app_rw (nền tảng
-- có BYPASSRLS và là bên duyệt).
REVOKE UPDATE, DELETE, TRUNCATE ON plan_change_request FROM app_rw;
GRANT  UPDATE (status, decided_by, decided_at) ON plan_change_request TO app_rw;

CREATE POLICY pcr_rw_insert ON plan_change_request AS RESTRICTIVE FOR INSERT TO app_rw
  WITH CHECK (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL AND decision_note IS NULL);
CREATE POLICY pcr_rw_update ON plan_change_request AS RESTRICTIVE FOR UPDATE TO app_rw
  USING (status = 'PENDING')
  WITH CHECK (status = 'CANCELLED');

-- ---------------------------------------------------------------------------
-- 3. Giao dịch ngân hàng nhận qua webhook.
--
-- Bảng của MẶT PHẲNG NỀN TẢNG, không thuộc phòng nào (nên không có tenant_id,
-- xem GLOBAL_TABLES trong tenant-isolation.spec.ts). Phòng khớp được thì ghi ở
-- `matched_tenant`.
--
-- Lưu MỌI giao dịch nhận được, kể cả không khớp: đây là bản sao sao kê. Người
-- đối soát xem ở đây thay vì mở app ngân hàng.
-- ---------------------------------------------------------------------------
CREATE TABLE bank_txn_event (
  id              bigserial PRIMARY KEY,
  provider        text NOT NULL CHECK (provider IN ('SEPAY')),
  provider_txn_id text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('IN', 'OUT')),
  amount          bigint NOT NULL CHECK (amount >= 0),
  content         text NOT NULL DEFAULT '',
  account_no      text,
  bank_ref        text,                         -- mã tham chiếu của ngân hàng
  txn_at          timestamptz,
  payload         jsonb NOT NULL,
  outcome         text NOT NULL
                  CHECK (outcome IN ('MATCHED', 'NO_MATCH', 'AMOUNT_MISMATCH',
                                     'ALREADY_SETTLED', 'AMBIGUOUS', 'IGNORED')),
  invoice_id      uuid REFERENCES tenant_billing_record(id),
  matched_tenant  uuid REFERENCES tenant(id),
  received_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid REFERENCES identity(id),
  resolved_at     timestamptz,
  resolve_note    text,
  CONSTRAINT bank_txn_resolved CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);
-- Ngân hàng / SePay GỬI LẠI khi không nhận được 200. Một giao dịch nhận hai lần
-- không được thành hai lần tất toán.
CREATE UNIQUE INDEX uq_bank_txn_provider ON bank_txn_event (provider, provider_txn_id);
CREATE INDEX ix_bank_txn_open ON bank_txn_event (received_at DESC)
  WHERE outcome NOT IN ('MATCHED', 'IGNORED') AND resolved_at IS NULL;

REVOKE ALL ON bank_txn_event FROM app_rw;
-- Là bằng chứng tiền vào: nền tảng đánh dấu "đã xử lý" được, không xoá được.
REVOKE DELETE, TRUNCATE ON bank_txn_event FROM app_platform;

-- "Không có đã thu vô danh" (0001) vẫn giữ: PAID thì hoặc có NGƯỜI xác nhận,
-- hoặc có DÒNG SAO KÊ đã khớp máy.
ALTER TABLE tenant_billing_record ADD COLUMN bank_event_id bigint REFERENCES bank_txn_event(id);
ALTER TABLE tenant_billing_record DROP CONSTRAINT billing_paid_needs_confirmation;
ALTER TABLE tenant_billing_record ADD CONSTRAINT billing_paid_needs_confirmation CHECK (
  status <> 'PAID'
  OR (confirmed_at IS NOT NULL AND (confirmed_by IS NOT NULL OR bank_event_id IS NOT NULL))
);

-- ---------------------------------------------------------------------------
-- Nhận một giao dịch. Chạy lặp bao nhiêu lần cũng như một (khoá theo mã giao
-- dịch của nhà cung cấp).
--
-- Khớp: bỏ mọi ký tự không phải chữ/số ở CẢ HAI phía rồi tìm mã hoá đơn TRONG
-- nội dung. Ngân hàng hay nuốt dấu cách, thêm tiền tố ("MBVCB.123.PT2610..."),
-- và người chuyển hay gõ thêm chữ — so bằng tuyệt đối sẽ trượt gần hết.
--
-- Chỉ tự tất toán khi ĐÚNG số tiền. Thiếu là chưa trả xong; dư là có chuyện
-- cần người hỏi lại — cả hai đều phải qua người.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_ingest_bank_txn(
  p_provider text, p_txn_id text, p_direction text, p_amount bigint, p_content text,
  p_account text, p_bank_ref text, p_txn_at timestamptz, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_id      bigint;
  v_norm    text := regexp_replace(upper(coalesce(p_content, '')), '[^A-Z0-9]', '', 'g');
  v_n       int;
  v_inv     tenant_billing_record%ROWTYPE;
  v_outcome text;
  v_old     record;
BEGIN
  INSERT INTO bank_txn_event (provider, provider_txn_id, direction, amount, content,
                              account_no, bank_ref, txn_at, payload, outcome)
  VALUES (p_provider, p_txn_id, p_direction, p_amount, coalesce(p_content, ''),
          p_account, p_bank_ref, p_txn_at, p_payload, 'NO_MATCH')
  ON CONFLICT (provider, provider_txn_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id, outcome, invoice_id INTO v_old
      FROM bank_txn_event WHERE provider = p_provider AND provider_txn_id = p_txn_id;
    RETURN jsonb_build_object('eventId', v_old.id, 'outcome', v_old.outcome,
                              'invoiceId', v_old.invoice_id, 'duplicate', true);
  END IF;

  IF p_direction <> 'IN' THEN
    UPDATE bank_txn_event SET outcome = 'IGNORED' WHERE id = v_id;
    RETURN jsonb_build_object('eventId', v_id, 'outcome', 'IGNORED', 'duplicate', false);
  END IF;

  -- Mã hoá đơn ngắn nhất ~12 ký tự ("PT2610" + slug + 4 hex); nội dung rỗng
  -- hoặc quá ngắn thì không khớp nổi cái gì.
  SELECT count(*) INTO v_n
    FROM tenant_billing_record b
   WHERE b.status = 'PENDING'
     AND length(v_norm) >= 8
     AND position(regexp_replace(upper(b.transfer_ref), '[^A-Z0-9]', '', 'g') IN v_norm) > 0;

  IF v_n > 1 THEN
    v_outcome := 'AMBIGUOUS';
  ELSIF v_n = 1 THEN
    SELECT * INTO v_inv
      FROM tenant_billing_record b
     WHERE b.status = 'PENDING'
       AND position(regexp_replace(upper(b.transfer_ref), '[^A-Z0-9]', '', 'g') IN v_norm) > 0
     FOR UPDATE;
    IF v_inv.amount = p_amount THEN
      -- bank_event_id TRƯỚC: ràng buộc billing_paid_needs_confirmation cần nó
      -- khi saas_settle_invoice đặt PAID với người xác nhận NULL.
      UPDATE tenant_billing_record SET bank_event_id = v_id WHERE id = v_inv.id;
      PERFORM saas_settle_invoice(v_inv.id, 'PAID', NULL, p_provider || ':' || p_txn_id, p_amount,
                                  'Tự khớp sao kê (' || p_provider || ')');
      v_outcome := 'MATCHED';
    ELSE
      v_outcome := 'AMOUNT_MISMATCH';
    END IF;
  ELSE
    -- Không còn hoá đơn mở nào khớp: có thể khách chuyển HAI lần cho cùng một
    -- hoá đơn — người đối soát cần thấy để hoàn tiền.
    SELECT * INTO v_inv
      FROM tenant_billing_record b
     WHERE b.status IN ('PAID', 'WAIVED')
       AND length(v_norm) >= 8
       AND position(regexp_replace(upper(b.transfer_ref), '[^A-Z0-9]', '', 'g') IN v_norm) > 0
     ORDER BY b.period_start DESC
     LIMIT 1;
    v_outcome := CASE WHEN FOUND THEN 'ALREADY_SETTLED' ELSE 'NO_MATCH' END;
  END IF;

  UPDATE bank_txn_event
     SET outcome = v_outcome, invoice_id = v_inv.id, matched_tenant = v_inv.tenant_id
   WHERE id = v_id;

  INSERT INTO platform_audit_log (actor_id, target_tenant, action, detail)
  VALUES (NULL, v_inv.tenant_id,
          CASE WHEN v_outcome = 'MATCHED' THEN 'invoice.auto_confirm' ELSE 'bank.unmatched' END,
          jsonb_build_object('outcome', v_outcome, 'amount', p_amount, 'bankTxnRef', p_provider || ':' || p_txn_id,
                             'transferRef', v_inv.transfer_ref, 'invoiceId', v_inv.id));

  RETURN jsonb_build_object('eventId', v_id, 'outcome', v_outcome,
                            'invoiceId', v_inv.id, 'duplicate', false);
END $fn$;

REVOKE ALL ON FUNCTION saas_ingest_bank_txn(text, text, text, bigint, text, text, text, timestamptz, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_ingest_bank_txn(text, text, text, bigint, text, text, text, timestamptz, jsonb) TO app_platform;
