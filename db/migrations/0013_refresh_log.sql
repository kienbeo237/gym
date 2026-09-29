-- =============================================================================
-- 0013 — Ghi lại mốc làm mới báo cáo.
--
-- PostgreSQL KHÔNG lưu thời điểm `REFRESH MATERIALIZED VIEW` chạy lần cuối.
-- Suy từ `pg_stat_get_last_analyze_time` là xấp xỉ sai: autovacuum chạy độc
-- lập với refresh, nên con số hiện trên màn hình sẽ lúc đúng lúc sai mà không
-- có quy luật nào.
--
-- Phải nói ra mốc này trên giao diện: số liệu tổng hợp có độ trễ, và người dùng
-- đối chiếu với màn hoá đơn (đọc bảng gốc, luôn tức thời) sẽ thấy lệch. Không
-- hiển thị mốc thì họ kết luận hệ thống sai.
--
-- Bảng TOÀN CỤC, không có tenant_id: matview là một khối chung cho mọi phòng
-- tập nên mốc làm mới cũng chung. Vì thế nó nằm trong allowlist của cổng gác A.
-- =============================================================================

CREATE TABLE reporting_refresh_log (
  id          bigserial PRIMARY KEY,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  duration_ms  int NOT NULL
);

GRANT SELECT ON reporting_refresh_log TO app_rw;

-- Chỉ giữ một dòng: đây là "lần cuối", không phải nhật ký.
CREATE OR REPLACE FUNCTION refresh_reporting() RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  t0 timestamptz := clock_timestamp();
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trainer_month;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_tenant_month;
  REFRESH MATERIALIZED VIEW CONCURRENTLY mv_package_month;

  DELETE FROM reporting_refresh_log;
  INSERT INTO reporting_refresh_log (duration_ms)
  VALUES (EXTRACT(MILLISECONDS FROM clock_timestamp() - t0)::int);
END $fn$;

REVOKE ALL ON FUNCTION refresh_reporting() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_reporting() TO app_rw;

-- Chạy một lần để có mốc ngay sau khi migrate.
SELECT refresh_reporting();
