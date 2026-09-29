-- =============================================================================
-- 0003 — Hoá đơn, trả góp, thu tiền.
--
-- Phân biệt ba con số, cố ý KHÔNG gộp:
--   invoice.total_amount   — số phải thu (đã chốt, không đổi sau khi phát hành)
--   invoice.paid_amount    — số ĐÃ THU (dòng tiền)  <- payment
--   revenue_entry.amount   — doanh thu GHI NHẬN (theo buổi đã dùng, ở 0002)
-- Gộp chúng lại là mất khả năng trả lời "tháng này thu bao nhiêu" và
-- "tháng này làm ra bao nhiêu" như hai câu hỏi khác nhau.
-- =============================================================================

CREATE TABLE invoice (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL,
  code         text NOT NULL,
  issued_at    timestamptz NOT NULL DEFAULT now(),
  total_amount bigint NOT NULL CHECK (total_amount >= 0),
  -- Bản cache của SUM(payment.signed_amount). Ghi cùng transaction với payment.
  paid_amount  bigint NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'OPEN'
               CHECK (status IN ('DRAFT','OPEN','PARTIALLY_PAID','PAID','VOID','REFUNDED')),
  -- Trả góp: kế hoạch nằm ở payment_schedule. Cột này chỉ để lọc nhanh.
  is_installment boolean NOT NULL DEFAULT false,
  pdf_file_id  uuid REFERENCES file_object(id),
  note         text,
  created_by   uuid REFERENCES identity(id),
  voided_at    timestamptz,
  voided_by    uuid REFERENCES identity(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_invoice_anchor UNIQUE (tenant_id, id),
  CONSTRAINT uq_invoice_code   UNIQUE (tenant_id, code),
  -- Thu vượt được phép (làm tròn, khách trả dư) nhưng không âm.
  CONSTRAINT invoice_paid_nonneg CHECK (paid_amount >= 0),
  CONSTRAINT fk_invoice_member FOREIGN KEY (tenant_id, member_id)
    REFERENCES member (tenant_id, id)
);
CREATE INDEX ix_invoice_member ON invoice (tenant_id, member_id, issued_at DESC);
CREATE INDEX ix_invoice_unpaid ON invoice (tenant_id, status)
  WHERE status IN ('OPEN','PARTIALLY_PAID');
CREATE TRIGGER trg_invoice_updated BEFORE UPDATE ON invoice
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_item (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  invoice_id        uuid NOT NULL,
  member_package_id uuid,                 -- NULL = khoản thu khác (phí thẻ, PT lẻ...)
  description       text   NOT NULL,
  quantity          int    NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price        bigint NOT NULL CHECK (unit_price >= 0),
  amount            bigint NOT NULL CHECK (amount >= 0),
  CONSTRAINT fk_item_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoice (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_item_mp FOREIGN KEY (tenant_id, member_package_id)
    REFERENCES member_package (tenant_id, id)
);
CREATE INDEX ix_invoice_item_invoice ON invoice_item (invoice_id);

-- Kế hoạch trả góp. Một hoá đơn nhiều đợt; mỗi đợt có hạn riêng.
CREATE TABLE payment_schedule (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL,
  seq        int  NOT NULL CHECK (seq > 0),
  due_date   date NOT NULL,
  amount     bigint NOT NULL CHECK (amount > 0),
  status     text NOT NULL DEFAULT 'DUE'
             CHECK (status IN ('DUE','PAID','OVERDUE','WAIVED')),
  CONSTRAINT uq_schedule_anchor UNIQUE (tenant_id, id),
  CONSTRAINT uq_schedule_seq    UNIQUE (invoice_id, seq),
  CONSTRAINT fk_schedule_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoice (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX ix_schedule_due ON payment_schedule (tenant_id, due_date)
  WHERE status IN ('DUE','OVERDUE');

CREATE TABLE payment (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  invoice_id    uuid NOT NULL,
  schedule_id   uuid,                  -- đợt trả góp tương ứng, NULL nếu trả tự do
  kind          text NOT NULL DEFAULT 'PAYMENT' CHECK (kind IN ('PAYMENT','REFUND')),
  amount        bigint NOT NULL CHECK (amount > 0),
  -- Dấu suy từ kind. Hoàn tiền là dòng RIÊNG, không sửa dòng thu cũ:
  -- lịch sử tiền phải cộng dồn được, không được viết đè.
  signed_amount bigint GENERATED ALWAYS AS
                (CASE WHEN kind = 'REFUND' THEN -amount ELSE amount END) STORED,
  method        text NOT NULL CHECK (method IN ('CASH','BANK_TRANSFER','CARD','EWALLET','OTHER')),
  paid_at       timestamptz NOT NULL DEFAULT now(),
  reference     text,                  -- mã giao dịch / nội dung chuyển khoản
  received_by   uuid REFERENCES identity(id),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_anchor UNIQUE (tenant_id, id),
  CONSTRAINT fk_payment_invoice FOREIGN KEY (tenant_id, invoice_id)
    REFERENCES invoice (tenant_id, id),
  CONSTRAINT fk_payment_schedule FOREIGN KEY (tenant_id, schedule_id)
    REFERENCES payment_schedule (tenant_id, id)
);
CREATE INDEX ix_payment_invoice ON payment (invoice_id, paid_at);
CREATE INDEX ix_payment_cashflow ON payment (tenant_id, paid_at);

-- Khoá ngoại ngược từ commission_entry sang payment: khai ở đây vì payment
-- sinh sau commission_entry trong thứ tự migration.
ALTER TABLE commission_entry
  ADD CONSTRAINT fk_comm_payment FOREIGN KEY (tenant_id, payment_id)
  REFERENCES payment (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Đối soát: số dư buổi tập của sổ cái phải khớp bản cache trên member_package.
-- Chạy hằng đêm. Lệch thì CẢNH BÁO, không tự sửa — tự sửa là giấu mất nguyên nhân.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_session_balance_drift AS
SELECT mp.tenant_id,
       mp.id                                   AS member_package_id,
       mp.code,
       mp.sessions_total,
       mp.sessions_used                        AS cached_used,
       mp.sessions_total - COALESCE(SUM(sl.delta), 0) AS ledger_used,
       mp.sessions_used - (mp.sessions_total - COALESCE(SUM(sl.delta), 0)) AS drift
FROM member_package mp
LEFT JOIN session_ledger sl ON sl.member_package_id = mp.id
GROUP BY mp.tenant_id, mp.id, mp.code, mp.sessions_total, mp.sessions_used
HAVING mp.sessions_used <> (mp.sessions_total - COALESCE(SUM(sl.delta), 0));

-- Đối soát tiền: bản cache paid_amount phải khớp tổng các lần thu/hoàn.
CREATE OR REPLACE VIEW v_invoice_paid_drift AS
SELECT i.tenant_id,
       i.id AS invoice_id,
       i.code,
       i.paid_amount                      AS cached_paid,
       COALESCE(SUM(p.signed_amount), 0)  AS ledger_paid,
       i.paid_amount - COALESCE(SUM(p.signed_amount), 0) AS drift
FROM invoice i
LEFT JOIN payment p ON p.invoice_id = i.id
GROUP BY i.tenant_id, i.id, i.code, i.paid_amount
HAVING i.paid_amount <> COALESCE(SUM(p.signed_amount), 0);
