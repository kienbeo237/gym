-- =============================================================================
-- 0012 — Phase 4: báo cáo (materialized view) và bảng lương huấn luyện viên.
--
-- ⚠️ PHÁT HIỆN QUAN TRỌNG, đo thật trước khi viết file này:
--
--   PostgreSQL KHÔNG CHO bật RLS trên materialized view.
--     ALTER MATERIALIZED VIEW ... ENABLE ROW LEVEL SECURITY
--     -> ERROR: This operation is not supported for materialized views.
--
--   Đo hậu quả: cấp SELECT matview cho app_rw rồi đặt app.tenant_id = Alpha,
--   nó đọc được CẢ HAI phòng. Toàn bộ lớp cách ly của dự án bị vô hiệu ở đúng
--   chỗ chứa số liệu tổng hợp — thứ mà phòng tập cạnh tranh nhau quan tâm nhất.
--
--   Và cổng gác nhóm A chỉ quét `relkind = 'r'` (bảng thường), nên matview
--   hoàn toàn VÔ HÌNH với nó.
--
-- CÁCH LÀM ở file này, và mọi matview về sau phải theo:
--   1. matview thuộc sở hữu pt_migrator, REVOKE ALL khỏi app_rw và PUBLIC
--   2. lộ ra ngoài qua một VIEW THƯỜNG có mệnh đề tenant, `security_barrier`
--   3. view thường chạy bằng quyền của CHỦ SỞ HỮU (không đặt security_invoker),
--      nhờ đó app_rw đọc được qua nó mà không chạm thẳng vào matview
--   4. mệnh đề dùng NULLIF(..., '') như RLS policy — thiếu nó thì lời gọi chưa
--      có ngữ cảnh tenant nhận 'invalid input syntax for type uuid' (lỗi 500)
--      thay vì 0 dòng
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Số liệu theo HUẤN LUYỆN VIÊN × THÁNG.
--
-- Gộp hai nguồn bằng UNION ALL rồi mới tổng hợp, thay vì JOIN: một buổi tập có
-- doanh thu nhưng có thể không có hoa hồng (vắng mặt), và một lần thu tiền có
-- hoa hồng nhưng không có buổi nào. JOIN sẽ mất dòng hoặc nhân đôi dòng.
--
-- Mốc tháng cắt theo GIỜ VIỆT NAM ở cả hai nhánh.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_trainer_month AS
SELECT x.tenant_id,
       x.trainer_id,
       x.period_month,
       SUM(x.sessions_taught)::int    AS sessions_taught,
       SUM(x.sessions_deducted)::int  AS sessions_deducted,
       SUM(x.revenue)::bigint         AS revenue_recognized,
       SUM(x.commission_sale)::bigint AS commission_sale,
       SUM(x.commission_teach)::bigint AS commission_teach
FROM (
  SELECT re.tenant_id,
         re.trainer_id,
         date_trunc('month', re.recognized_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS period_month,
         CASE WHEN re.source = 'CHECKIN' THEN 1 ELSE 0 END AS sessions_taught,
         1                                                 AS sessions_deducted,
         re.amount                                         AS revenue,
         0::bigint                                         AS commission_sale,
         0::bigint                                         AS commission_teach
  FROM revenue_entry re
  UNION ALL
  SELECT ce.tenant_id,
         ce.trainer_id,
         ce.period_month,
         0, 0, 0::bigint,
         CASE WHEN ce.kind = 'SALE'  THEN ce.amount ELSE 0 END,
         CASE WHEN ce.kind = 'TEACH' THEN ce.amount ELSE 0 END
  FROM commission_entry ce
) x
GROUP BY x.tenant_id, x.trainer_id, x.period_month;

-- UNIQUE index là ĐIỀU KIỆN để REFRESH ... CONCURRENTLY chạy được. Thiếu nó
-- thì mỗi lần làm mới sẽ khoá toàn bộ matview và màn báo cáo treo.
CREATE UNIQUE INDEX uq_mv_trainer_month ON mv_trainer_month (tenant_id, trainer_id, period_month);

-- ---------------------------------------------------------------------------
-- 2. Số liệu theo PHÒNG TẬP × THÁNG.
--
-- `cash_in` / `cash_out` tính theo NGÀY TIỀN VÀO; `revenue_recognized` tính
-- theo NGÀY BUỔI TẬP ĐƯỢC DÙNG. Hai cột này CỐ Ý không bằng nhau — đó là toàn
-- bộ lý do phân biệt dòng tiền với doanh thu.
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_tenant_month AS
SELECT x.tenant_id,
       x.period_month,
       SUM(x.cash_in)::bigint            AS cash_in,
       SUM(x.cash_out)::bigint           AS cash_out,
       SUM(x.revenue)::bigint            AS revenue_recognized,
       SUM(x.sessions_taught)::int       AS sessions_taught,
       SUM(x.sessions_deducted)::int     AS sessions_deducted,
       SUM(x.packages_sold)::int         AS packages_sold,
       SUM(x.gross_sales)::bigint        AS gross_sales,
       SUM(x.new_members)::int           AS new_members
FROM (
  SELECT p.tenant_id,
         date_trunc('month', p.paid_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS period_month,
         CASE WHEN p.kind = 'PAYMENT' THEN p.amount ELSE 0 END AS cash_in,
         CASE WHEN p.kind = 'REFUND'  THEN p.amount ELSE 0 END AS cash_out,
         0::bigint AS revenue, 0 AS sessions_taught, 0 AS sessions_deducted,
         0 AS packages_sold, 0::bigint AS gross_sales, 0 AS new_members
  FROM payment p
  UNION ALL
  SELECT re.tenant_id,
         date_trunc('month', re.recognized_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
         0::bigint, 0::bigint, re.amount,
         CASE WHEN re.source = 'CHECKIN' THEN 1 ELSE 0 END, 1,
         0, 0::bigint, 0
  FROM revenue_entry re
  UNION ALL
  SELECT mp.tenant_id,
         date_trunc('month', mp.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
         0::bigint, 0::bigint, 0::bigint, 0, 0,
         1, mp.price_net, 0
  FROM member_package mp
  WHERE mp.status <> 'CANCELLED'
  UNION ALL
  SELECT m.tenant_id,
         date_trunc('month', m.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
         0::bigint, 0::bigint, 0::bigint, 0, 0, 0, 0::bigint, 1
  FROM member m
) x
GROUP BY x.tenant_id, x.period_month;

CREATE UNIQUE INDEX uq_mv_tenant_month ON mv_tenant_month (tenant_id, period_month);

-- ---------------------------------------------------------------------------
-- 3. Doanh số theo GÓI × THÁNG — trả lời "gói nào bán chạy, gói nào lỗ chỗ".
-- ---------------------------------------------------------------------------
CREATE MATERIALIZED VIEW mv_package_month AS
SELECT mp.tenant_id,
       mp.template_id,
       date_trunc('month', mp.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS period_month,
       count(*)::int                        AS sold_count,
       SUM(mp.price_gross)::bigint          AS gross_amount,
       SUM(mp.discount)::bigint             AS discount_amount,
       SUM(mp.price_net)::bigint            AS net_amount,
       SUM(mp.sessions_total)::int          AS sessions_sold,
       SUM(mp.sessions_used)::int           AS sessions_used
FROM member_package mp
WHERE mp.status <> 'CANCELLED'
GROUP BY mp.tenant_id, mp.template_id,
         date_trunc('month', mp.created_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date;

CREATE UNIQUE INDEX uq_mv_package_month ON mv_package_month (tenant_id, template_id, period_month);

-- ---------------------------------------------------------------------------
-- 4. Lớp bọc — con đường DUY NHẤT app_rw chạm tới số liệu tổng hợp.
-- ---------------------------------------------------------------------------
REVOKE ALL ON mv_trainer_month, mv_tenant_month, mv_package_month FROM PUBLIC, app_rw, app_auth;

CREATE VIEW v_trainer_month WITH (security_barrier = true) AS
  SELECT * FROM mv_trainer_month
  WHERE tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid;

CREATE VIEW v_tenant_month WITH (security_barrier = true) AS
  SELECT * FROM mv_tenant_month
  WHERE tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid;

CREATE VIEW v_package_month WITH (security_barrier = true) AS
  SELECT * FROM mv_package_month
  WHERE tenant_id = NULLIF(current_setting('app.tenant_id', TRUE), '')::uuid;

GRANT SELECT ON v_trainer_month, v_tenant_month, v_package_month TO app_rw;

-- ---------------------------------------------------------------------------
-- 5. Làm mới báo cáo.
--
-- app_rw không sở hữu matview nên không REFRESH được — đi qua hàm SECURITY
-- DEFINER. Hàm này làm mới cho MỌI phòng tập cùng lúc (matview là một khối),
-- nhưng nó KHÔNG trả về dòng nào nên không lộ dữ liệu.
--
-- Giới hạn tần suất do tầng ứng dụng lo: một phòng tập bấm liên tục sẽ làm
-- nặng cả hệ thống. Đường đúng về lâu dài là job định kỳ, không phải nút bấm.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION refresh_reporting() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trainer_month;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_tenant_month;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_package_month;
END $fn$;

REVOKE ALL ON FUNCTION refresh_reporting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_reporting() TO app_rw;

-- ---------------------------------------------------------------------------
-- 6. BẢNG LƯƠNG.
--
-- Chốt lương là hành động ĐÓNG BĂNG số liệu, giống mọi chỗ khác trong hệ thống:
-- sửa chính sách hoa hồng tháng sau không được làm đổi bảng lương đã chốt.
-- ---------------------------------------------------------------------------
CREATE TABLE payroll_run (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  period_month date NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT'
               CHECK (status IN ('DRAFT', 'CLOSED', 'PAID')),
  closed_at    timestamptz,
  closed_by    uuid REFERENCES identity(id),
  paid_at      timestamptz,
  paid_by      uuid REFERENCES identity(id),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payroll_run_anchor UNIQUE (tenant_id, id),
  CONSTRAINT uq_payroll_run_period UNIQUE (tenant_id, period_month),
  CONSTRAINT payroll_month_is_first_day CHECK (date_trunc('month', period_month) = period_month),
  CONSTRAINT payroll_closed_needs_actor CHECK (
    status = 'DRAFT' OR (closed_at IS NOT NULL AND closed_by IS NOT NULL)
  ),
  CONSTRAINT payroll_paid_needs_actor CHECK (
    status <> 'PAID' OR (paid_at IS NOT NULL AND paid_by IS NOT NULL)
  )
);

CREATE TABLE payroll_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  run_id           uuid NOT NULL,
  trainer_id       uuid NOT NULL,
  -- Ảnh chụp tại thời điểm chốt. `trainer.base_salary` đổi về sau không được
  -- làm đổi bảng lương đã chốt.
  base_salary      bigint NOT NULL,
  commission_sale  bigint NOT NULL DEFAULT 0,
  commission_teach bigint NOT NULL DEFAULT 0,
  adjustment       bigint NOT NULL DEFAULT 0,
  adjustment_note  text,
  total            bigint GENERATED ALWAYS AS
                   (base_salary + commission_sale + commission_teach + adjustment) STORED,
  sessions_taught  int NOT NULL DEFAULT 0,
  CONSTRAINT uq_payroll_line_anchor  UNIQUE (tenant_id, id),
  CONSTRAINT uq_payroll_line_trainer UNIQUE (run_id, trainer_id),
  CONSTRAINT payroll_line_adj_note CHECK (adjustment = 0 OR adjustment_note IS NOT NULL),
  CONSTRAINT fk_payroll_line_run FOREIGN KEY (tenant_id, run_id)
    REFERENCES payroll_run (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_payroll_line_trainer FOREIGN KEY (tenant_id, trainer_id)
    REFERENCES trainer (tenant_id, id)
);
CREATE INDEX ix_payroll_line_run ON payroll_line (run_id);

-- Mỗi dòng hoa hồng thuộc TỐI ĐA một bảng lương. Đây là thứ chặn trả hai lần.
ALTER TABLE commission_entry
  ADD COLUMN payroll_line_id uuid,
  ADD CONSTRAINT fk_commission_payroll FOREIGN KEY (tenant_id, payroll_line_id)
    REFERENCES payroll_line (tenant_id, id) ON DELETE SET NULL;

CREATE INDEX ix_commission_unpaid ON commission_entry (tenant_id, trainer_id, period_month)
  WHERE payroll_line_id IS NULL;

SELECT enable_tenant_rls('payroll_run');
SELECT enable_tenant_rls('payroll_line');

-- ---------------------------------------------------------------------------
-- 7. Đối soát bảng lương: tổng hoa hồng đã gắn vào một dòng lương phải khớp
--    đúng các con số đã chốt trên dòng đó.
--
-- Lệch = hoặc có dòng hoa hồng bị gỡ ra sau khi chốt, hoặc con số chốt sai.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_payroll_drift AS
SELECT pl.tenant_id,
       pl.run_id,
       pl.id                AS payroll_line_id,
       pl.trainer_id,
       pl.commission_sale   AS chot_ban,
       pl.commission_teach  AS chot_day,
       COALESCE(SUM(ce.amount) FILTER (WHERE ce.kind = 'SALE'), 0)  AS thuc_ban,
       COALESCE(SUM(ce.amount) FILTER (WHERE ce.kind = 'TEACH'), 0) AS thuc_day
FROM payroll_line pl
LEFT JOIN commission_entry ce ON ce.payroll_line_id = pl.id
GROUP BY pl.tenant_id, pl.run_id, pl.id, pl.trainer_id, pl.commission_sale, pl.commission_teach
HAVING pl.commission_sale  <> COALESCE(SUM(ce.amount) FILTER (WHERE ce.kind = 'SALE'), 0)
    OR pl.commission_teach <> COALESCE(SUM(ce.amount) FILTER (WHERE ce.kind = 'TEACH'), 0);
