-- =============================================================================
-- 0018 — Việc tự động của vận hành (Batch B)
--
--   1. tenant_policy.auto_no_show: tự đánh vắng mặt — TẮT mặc định
--   2. reconciliation_run: kết quả chạy định kỳ tám view đối soát
--   3. app_rw không đọc được view đối soát (chúng chạy bằng quyền chủ sở hữu,
--      tức KHÔNG qua RLS — đọc được là thấy mọi phòng)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tự đánh vắng mặt.
--
-- Vắng mặt TRỪ BUỔI của khách (nếu gói trừ khi vắng) — tức là thao tác tiền.
-- Để máy tự làm thì chủ phòng phải tự bật, có chủ đích. Mặc định: tắt, lễ tân
-- vẫn bấm tay như cũ.
--
-- Máy chỉ đánh vắng khi cửa sổ điểm danh ĐÃ ĐÓNG (giờ bắt đầu + ân hạn điểm
-- danh + 4 giờ, khớp CheckinService) — không bao giờ tranh với lễ tân đang
-- điểm danh muộn.
-- ---------------------------------------------------------------------------
ALTER TABLE tenant_policy
  ADD COLUMN auto_no_show boolean NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Nhật ký chạy đối soát.
--
-- Bảng CHUNG (không tenant_id): một lần chạy quét mọi phòng. Chỉ nền tảng đọc —
-- lệch dữ liệu là lỗi của HỆ THỐNG, không phải việc chủ phòng xử lý.
-- ---------------------------------------------------------------------------
CREATE TABLE reconciliation_run (
  id          bigserial PRIMARY KEY,
  ran_at      timestamptz NOT NULL DEFAULT now(),
  -- { "v_revenue_drift": 0, ... } — đủ tám view, kể cả view rỗng: thiếu một
  -- khoá nghĩa là view đó không chạy được, khác hẳn "chạy và rỗng".
  counts      jsonb NOT NULL,
  total       int  NOT NULL CHECK (total >= 0),
  -- Tối đa vài dòng mẫu mỗi view lệch, để người trực đọc được ngay.
  samples     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- View nào lỗi khi chạy (thiếu quyền, bị đổi tên...). Lỗi cũng là báo động.
  errors      jsonb NOT NULL DEFAULT '{}'::jsonb,
  duration_ms int  NOT NULL DEFAULT 0
);
CREATE INDEX ix_recon_run_at ON reconciliation_run (ran_at DESC);

REVOKE ALL ON reconciliation_run FROM app_rw, app_auth;
REVOKE UPDATE, DELETE, TRUNCATE ON reconciliation_run FROM app_platform;

-- ---------------------------------------------------------------------------
-- 3. View đối soát: chỉ nền tảng (và migrator) đọc.
--
-- View thường chạy bằng quyền CHỦ SỞ HỮU. Chủ sở hữu ở đây là pt_migrator —
-- RLS không áp cho nó — nên app_rw SELECT một view đối soát là thấy dòng của
-- MỌI phòng. Chưa có đường code nào làm vậy; thu quyền để không bao giờ có.
-- ---------------------------------------------------------------------------
REVOKE ALL ON v_session_balance_drift, v_invoice_paid_drift, v_sale_commission_drift,
              v_commission_needs_policy, v_revenue_drift, v_teach_commission_drift,
              v_revenue_over_contract, v_payroll_drift
  FROM app_rw, app_auth, PUBLIC;
GRANT SELECT ON v_session_balance_drift, v_invoice_paid_drift, v_sale_commission_drift,
                v_commission_needs_policy, v_revenue_drift, v_teach_commission_drift,
                v_revenue_over_contract, v_payroll_drift
  TO app_platform;
