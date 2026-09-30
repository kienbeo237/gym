-- =============================================================================
-- 0016 — Phase 7: hạn mức gói SaaS, quản trị nền tảng, đối soát thu tiền thủ công.
--
-- Bảng đã có từ 0001 (plan, tenant_subscription, tenant_billing_record,
-- platform_admin, platform_audit_log). Migration này thêm VÒNG ĐỜI cho chúng:
--
--   dùng thử ─┐
--             ├─ hết kỳ đã trả ─> PAST_DUE ─ quá 7 ngày ─> SUSPENDED (chỉ đọc)
--   đang dùng ┘        ▲                                     │
--                      └──── xác nhận chuyển khoản ◄─────────┘
--
-- MỌI chuyển trạng thái nằm ở file này, dưới dạng hàm SQL chạy bằng
-- app_platform. API (nút "xác nhận đã nhận tiền") và worker (job hằng giờ) chỉ
-- GỌI hàm — không ai tự viết lại luật chuyển trạng thái ở tầng TypeScript. Hai
-- nơi cùng viết luật là hai nơi sẽ lệch nhau, và lệch ở đây là khoá nhầm một
-- phòng tập đã trả tiền.
--
-- Không hàm nào ở đây là SECURITY DEFINER, và không hàm nào app_rw gọi được:
-- phòng tập không có cách nào tự đổi gói, tự gia hạn hay tự mở khoá.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Danh mục gói thuộc về MIGRATION, không thuộc về seed.
--
-- Trước đây chỉ seed tạo gói, nên môi trường thật (không chạy seed) không có
-- gói nào — và `assert_quota` coi "không có gói" là "không giới hạn". Giá sửa
-- sau bằng SQL cũng được: ON CONFLICT DO NOTHING không ghi đè giá đã đổi.
-- ---------------------------------------------------------------------------
INSERT INTO plan (code, name, max_trainers, max_members, max_messages_month, price_monthly, sort_order)
VALUES ('FREE',  'Dùng thử',       2,   50,   200,       0, 1),
       ('BASIC', 'Cơ bản',         5,  300,  2000,  990000, 2),
       ('PRO',   'Chuyên nghiệp', 20, 2000, 20000, 2990000, 3)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Phòng tập: VÌ SAO bị khoá.
--
-- Khoá vì nợ (BILLING) thì trả tiền là tự mở. Khoá tay (MANUAL — vi phạm điều
-- khoản, chủ phòng yêu cầu) thì trả tiền KHÔNG được tự mở: không có cột này,
-- xác nhận một khoản chuyển khoản sẽ lặng lẽ gỡ một lệnh khoá có chủ đích.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant
  ADD COLUMN suspend_kind text CHECK (suspend_kind IN ('BILLING', 'MANUAL')),
  ADD COLUMN status_note  text;
UPDATE tenant SET suspend_kind = 'MANUAL' WHERE status = 'SUSPENDED';
ALTER TABLE tenant ADD CONSTRAINT tenant_suspend_kind_match
  CHECK ((status = 'SUSPENDED') = (suspend_kind IS NOT NULL));

-- app_rw có UPDATE trên CẢ BẢNG tenant từ 0005 — tức phòng tập (qua một lỗi ở
-- API) tự đặt được status = 'ACTIVE' cho chính mình. RLS chỉ chặn sửa phòng
-- KHÁC, không chặn sửa cột. Thu lại, chỉ cấp những cột hồ sơ.
REVOKE UPDATE ON tenant FROM app_rw;
GRANT  UPDATE (name, timezone, logo_key) ON tenant TO app_rw;

-- ---------------------------------------------------------------------------
-- 3. Thuê bao: `current_period_end` = "ĐÃ TRẢ TỚI NGÀY NÀO".
--
-- Một định nghĩa cho mọi trạng thái, kể cả dùng thử (kỳ dùng thử là một kỳ
-- miễn phí). Kỳ kế tiếp luôn bắt đầu ở current_period_end + 1 — không có nhánh
-- "đang dùng thử thì tính từ trial_ends_at", vì nhánh đó là chỗ ngày bắt đầu
-- kỳ trôi theo ngày chạy job.
-- ---------------------------------------------------------------------------
-- Phòng đã có mà chưa có thuê bao (tạo tay trước phase 7): cho dùng thử gói
-- cao nhất 30 ngày, thay vì bất ngờ rơi xuống hạn mức gói miễn phí.
INSERT INTO tenant_subscription (tenant_id, plan_code, status, trial_ends_at, current_period_start, current_period_end)
SELECT t.id, 'PRO', 'TRIALING',
       ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 30)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh',
       (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
       (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 29
FROM tenant t
WHERE NOT EXISTS (SELECT 1 FROM tenant_subscription s WHERE s.tenant_id = t.id);

UPDATE tenant_subscription
   SET current_period_end = COALESCE((trial_ends_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1,
                                     (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 29)
 WHERE current_period_end IS NULL;
UPDATE tenant_subscription
   SET current_period_start = LEAST((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, current_period_end)
 WHERE current_period_start IS NULL;
ALTER TABLE tenant_subscription
  ALTER COLUMN current_period_start SET NOT NULL,
  ALTER COLUMN current_period_end   SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Hoá đơn SaaS.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_billing_record
  ADD COLUMN due_date     date,
  ADD COLUMN bank_txn_ref text,                                   -- mã giao dịch trên sao kê
  ADD COLUMN paid_amount  bigint CHECK (paid_amount >= 0),        -- số THỰC nhận
  ADD COLUMN created_by   uuid REFERENCES identity(id);           -- NULL = job tự phát hành
UPDATE tenant_billing_record SET due_date = period_start WHERE due_date IS NULL;
UPDATE tenant_billing_record SET paid_amount = amount WHERE status = 'PAID' AND paid_amount IS NULL;
ALTER TABLE tenant_billing_record ALTER COLUMN due_date SET NOT NULL;
-- Đã thu thì phải biết thu bao nhiêu — đối soát là so số này với sao kê.
ALTER TABLE tenant_billing_record ADD CONSTRAINT billing_paid_needs_amount
  CHECK (status <> 'PAID' OR paid_amount IS NOT NULL);

-- Huỷ (VOID) một hoá đơn rồi phát hành lại cho CÙNG kỳ phải được: sai giá,
-- vừa đổi gói. Nên "mỗi kỳ một hoá đơn" chỉ tính hoá đơn chưa huỷ.
DROP INDEX uq_billing_period;
CREATE UNIQUE INDEX uq_billing_period ON tenant_billing_record (tenant_id, period_start)
  WHERE status <> 'VOID';
CREATE INDEX ix_billing_open ON tenant_billing_record (due_date) WHERE status = 'PENDING';

-- Nội dung chuyển khoản: "PT2610 GYMALPHA 7C1E" = kỳ + tên phòng + 4 ký tự băm
-- từ id phòng. Người đối soát đọc sao kê là biết ngay phòng nào, kỳ nào; phần
-- băm chống hai phòng có tên rút gọn trùng nhau. Chỉ chữ và số, vì ngân hàng
-- hay nuốt dấu gạch và ký tự đặc biệt trong nội dung chuyển khoản.
CREATE OR REPLACE FUNCTION saas_transfer_ref(p_tenant uuid, p_period date)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $fn$
  SELECT 'PT' || to_char(p_period, 'YYMM') || ' '
         || upper(left(regexp_replace(t.slug::text, '[^a-zA-Z0-9]', '', 'g'), 10)) || ' '
         || upper(substr(md5(t.id::text), 1, 4))
  FROM tenant t WHERE t.id = p_tenant;
$fn$;

UPDATE tenant_billing_record SET transfer_ref = saas_transfer_ref(tenant_id, period_start)
 WHERE transfer_ref IS NULL;
ALTER TABLE tenant_billing_record ALTER COLUMN transfer_ref SET NOT NULL;
-- Duy nhất TOÀN NỀN TẢNG (không kèm tenant_id): một dòng sao kê phải trỏ về
-- đúng một hoá đơn. Hoá đơn bị huỷ nhường mã lại cho hoá đơn phát hành lại.
CREATE UNIQUE INDEX uq_billing_transfer_ref ON tenant_billing_record (transfer_ref)
  WHERE status <> 'VOID';

-- ---------------------------------------------------------------------------
-- 5. Phát hành hoá đơn cho kỳ KẾ TIẾP của một phòng.
--
-- Chỉ có kỳ kế tiếp, không có "kỳ tuỳ chọn": một phòng luôn có tối đa MỘT hoá
-- đơn đang mở, và kỳ chỉ tiến khi hoá đơn đó được thanh toán / miễn. Không có
-- cách nào để nợ chồng ba tháng mà không ai thấy.
--
-- Trả NULL nếu kỳ đó đã có hoá đơn (chưa huỷ).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_issue_invoice(p_tenant uuid, p_actor uuid, p_amount bigint, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_start date;
  v_plan  text;
  v_price bigint;
  v_id    uuid;
BEGIN
  SELECT s.current_period_end + 1, s.plan_code, p.price_monthly
    INTO v_start, v_plan, v_price
  FROM tenant_subscription s JOIN plan p ON p.code = s.plan_code
  WHERE s.tenant_id = p_tenant AND s.status <> 'CANCELLED';
  IF v_start IS NULL THEN
    RAISE EXCEPTION 'NO_SUBSCRIPTION' USING ERRCODE = 'no_data_found';
  END IF;

  INSERT INTO tenant_billing_record
    (tenant_id, period_start, period_end, plan_code, amount, due_date, transfer_ref, note, created_by)
  VALUES
    (p_tenant, v_start, (v_start + interval '1 month' - interval '1 day')::date, v_plan,
     COALESCE(p_amount, v_price), v_start, saas_transfer_ref(p_tenant, v_start), p_note, p_actor)
  ON CONFLICT (tenant_id, period_start) WHERE status <> 'VOID' DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

-- ---------------------------------------------------------------------------
-- 6. Tất toán hoá đơn (đã nhận tiền / miễn phí kỳ này) -> gia hạn + mở khoá.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_settle_invoice(
  p_invoice uuid, p_status text, p_actor uuid, p_bank_ref text, p_paid bigint, p_note text)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  b tenant_billing_record%ROWTYPE;
BEGIN
  IF p_status NOT IN ('PAID', 'WAIVED') THEN
    RAISE EXCEPTION 'SETTLE_BAD_STATUS:%', p_status USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO b FROM tenant_billing_record WHERE id = p_invoice FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  -- Bấm "xác nhận" hai lần (hai tab, mạng chậm) không được gia hạn hai lần.
  IF b.status <> 'PENDING' THEN
    RAISE EXCEPTION 'INVOICE_NOT_PENDING:%', b.status USING ERRCODE = 'check_violation';
  END IF;

  UPDATE tenant_billing_record
     SET status       = p_status,
         confirmed_by = p_actor,
         confirmed_at = now(),
         bank_txn_ref = CASE WHEN p_status = 'PAID' THEN p_bank_ref END,
         paid_amount  = CASE WHEN p_status = 'PAID' THEN p_paid END,
         note         = COALESCE(p_note, note)
   WHERE id = p_invoice;

  -- GREATEST: tất toán muộn một hoá đơn cũ không được kéo lùi ngày đã trả tới.
  UPDATE tenant_subscription
     SET status               = 'ACTIVE',
         current_period_start = b.period_start,
         current_period_end   = GREATEST(current_period_end, b.period_end)
   WHERE tenant_id = b.tenant_id AND status <> 'CANCELLED';

  -- Chỉ mở khoá do NỢ. Khoá tay giữ nguyên — xem mục 2.
  UPDATE tenant
     SET status = 'ACTIVE', suspend_kind = NULL, status_note = NULL
   WHERE id = b.tenant_id
     AND (status IN ('TRIAL', 'PAST_DUE') OR (status = 'SUSPENDED' AND suspend_kind = 'BILLING'));

  RETURN b.tenant_id;
END $fn$;

-- ---------------------------------------------------------------------------
-- 7. Vòng đời, chạy mỗi giờ bởi worker. Chạy lặp bao nhiêu lần cũng như một.
--
-- `p_today` là tham số để test (và người vận hành) chạy thử một ngày tương
-- lai trong một transaction rồi ROLLBACK, không phải chờ lịch thật.
--
-- Mỗi chuyển trạng thái ghi một dòng platform_audit_log với actor NULL = hệ
-- thống. Câu "vì sao phòng tôi bị khoá lúc 3 giờ sáng" phải có câu trả lời.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION saas_lifecycle_tick(
  p_today      date DEFAULT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
  p_lead_days  int  DEFAULT 7,
  p_grace_days int  DEFAULT 7)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  r          record;
  v_id       uuid;
  v_renewed  int := 0;
  v_issued   int := 0;
  v_past_due int := 0;
  v_suspend  int := 0;
BEGIN
  -- a. Gói 0đ: hết kỳ thì tự sang kỳ mới, không hoá đơn nào.
  FOR r IN
    SELECT s.tenant_id, s.status, s.current_period_end
    FROM tenant_subscription s
    JOIN plan p   ON p.code = s.plan_code
    JOIN tenant t ON t.id = s.tenant_id
    WHERE p.price_monthly = 0
      AND s.status IN ('TRIALING', 'ACTIVE', 'PAST_DUE')
      AND s.current_period_end < p_today
      AND t.status <> 'CLOSED'
    FOR UPDATE OF s
  LOOP
    UPDATE tenant_subscription
       SET status = 'ACTIVE', current_period_start = p_today,
           current_period_end = (p_today + interval '1 month' - interval '1 day')::date
     WHERE tenant_id = r.tenant_id;
    UPDATE tenant SET status = 'ACTIVE', suspend_kind = NULL, status_note = NULL
     WHERE id = r.tenant_id
       AND (status IN ('TRIAL', 'PAST_DUE') OR (status = 'SUSPENDED' AND suspend_kind = 'BILLING'));
    INSERT INTO platform_audit_log (actor_id, target_tenant, action, detail)
    VALUES (NULL, r.tenant_id, 'system.subscription.renew_free',
            jsonb_build_object('from', r.status, 'paidThrough', r.current_period_end));
    v_renewed := v_renewed + 1;
  END LOOP;

  -- b. Phát hành hoá đơn kỳ tới, trước `p_lead_days` ngày.
  FOR r IN
    SELECT s.tenant_id, s.current_period_end + 1 AS ns
    FROM tenant_subscription s
    JOIN plan p   ON p.code = s.plan_code
    JOIN tenant t ON t.id = s.tenant_id
    WHERE p.price_monthly > 0
      AND s.status IN ('TRIALING', 'ACTIVE', 'PAST_DUE')
      AND t.status <> 'CLOSED'
      AND s.current_period_end + 1 - p_lead_days <= p_today
      AND NOT EXISTS (SELECT 1 FROM tenant_billing_record b
                      WHERE b.tenant_id = s.tenant_id AND b.period_start = s.current_period_end + 1
                        AND b.status <> 'VOID')
  LOOP
    v_id := saas_issue_invoice(r.tenant_id, NULL, NULL, NULL);
    IF v_id IS NOT NULL THEN
      INSERT INTO platform_audit_log (actor_id, target_tenant, action, detail)
      VALUES (NULL, r.tenant_id, 'system.invoice.issue',
              jsonb_build_object('invoiceId', v_id, 'periodStart', r.ns));
      v_issued := v_issued + 1;
    END IF;
  END LOOP;

  -- c. Hết kỳ đã trả mà chưa trả kỳ mới -> quá hạn.
  FOR r IN
    SELECT s.tenant_id, s.status, s.current_period_end
    FROM tenant_subscription s
    JOIN plan p   ON p.code = s.plan_code
    JOIN tenant t ON t.id = s.tenant_id
    WHERE p.price_monthly > 0
      AND s.status IN ('TRIALING', 'ACTIVE')
      AND s.current_period_end < p_today
      AND t.status <> 'CLOSED'
    FOR UPDATE OF s
  LOOP
    UPDATE tenant_subscription SET status = 'PAST_DUE' WHERE tenant_id = r.tenant_id;
    UPDATE tenant SET status = 'PAST_DUE' WHERE id = r.tenant_id AND status IN ('TRIAL', 'ACTIVE');
    INSERT INTO platform_audit_log (actor_id, target_tenant, action, detail)
    VALUES (NULL, r.tenant_id, 'system.subscription.past_due',
            jsonb_build_object('from', r.status, 'paidThrough', r.current_period_end));
    v_past_due := v_past_due + 1;
  END LOOP;

  -- d. Quá hạn quá `p_grace_days` ngày -> tạm khoá (chỉ đọc).
  FOR r IN
    SELECT s.tenant_id, s.current_period_end
    FROM tenant_subscription s
    JOIN tenant t ON t.id = s.tenant_id
    WHERE s.status = 'PAST_DUE'
      AND t.status = 'PAST_DUE'
      AND s.current_period_end + p_grace_days < p_today
    FOR UPDATE OF t
  LOOP
    UPDATE tenant
       SET status = 'SUSPENDED', suspend_kind = 'BILLING',
           status_note = 'Quá hạn thanh toán từ ' || to_char(r.current_period_end + 1, 'DD/MM/YYYY')
     WHERE id = r.tenant_id;
    INSERT INTO platform_audit_log (actor_id, target_tenant, action, detail)
    VALUES (NULL, r.tenant_id, 'system.tenant.suspend',
            jsonb_build_object('kind', 'BILLING', 'paidThrough', r.current_period_end));
    v_suspend := v_suspend + 1;
  END LOOP;

  RETURN jsonb_build_object('renewedFree', v_renewed, 'invoicesIssued', v_issued,
                            'pastDue', v_past_due, 'suspended', v_suspend);
END $fn$;

REVOKE ALL ON FUNCTION saas_transfer_ref(uuid, date)                              FROM PUBLIC;
REVOKE ALL ON FUNCTION saas_issue_invoice(uuid, uuid, bigint, text)               FROM PUBLIC;
REVOKE ALL ON FUNCTION saas_settle_invoice(uuid, text, uuid, text, bigint, text)  FROM PUBLIC;
REVOKE ALL ON FUNCTION saas_lifecycle_tick(date, int, int)                        FROM PUBLIC;
GRANT EXECUTE ON FUNCTION saas_transfer_ref(uuid, date)                             TO app_platform;
GRANT EXECUTE ON FUNCTION saas_issue_invoice(uuid, uuid, bigint, text)              TO app_platform;
GRANT EXECUTE ON FUNCTION saas_settle_invoice(uuid, text, uuid, text, bigint, text) TO app_platform;
GRANT EXECUTE ON FUNCTION saas_lifecycle_tick(date, int, int)                       TO app_platform;

-- ---------------------------------------------------------------------------
-- 8. Nhật ký nền tảng: CHỈ GHI THÊM.
--
-- app_platform là role nhìn xuyên mọi phòng tập; nhật ký là thứ duy nhất trả
-- lời "ai đã nhìn / sửa gì". Role bị kiểm toán mà xoá được nhật ký của chính
-- nó thì nhật ký vô nghĩa.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_log FROM app_platform;
CREATE INDEX ix_platform_audit_time ON platform_audit_log (created_at DESC);
