-- 0019: sửa hành động ON DELETE của fk_commission_payroll (0012).
--
-- FK HAI CỘT (tenant_id, payroll_line_id) với `ON DELETE SET NULL` trơn đặt
-- NULL CẢ HAI cột của dòng tham chiếu — tức xoá tenant_id của dòng hoa hồng,
-- và NOT NULL chặn lại. Lỗi nằm im từ 0012 vì chưa có gì xoá payroll_line; nó
-- lộ ra khi "mở lại bảng lương" (xoá payroll_run -> CASCADE payroll_line)
-- được viết (phase8-ops.spec.ts bắt được).
--
-- PostgreSQL 15+ cho chỉ định cột: chỉ payroll_line_id về NULL, tenant_id giữ
-- nguyên. Dòng hoa hồng quay lại "chưa trả" đúng như thiết kế.

ALTER TABLE commission_entry
  DROP CONSTRAINT fk_commission_payroll,
  ADD CONSTRAINT fk_commission_payroll FOREIGN KEY (tenant_id, payroll_line_id)
    REFERENCES payroll_line (tenant_id, id) ON DELETE SET NULL (payroll_line_id);
