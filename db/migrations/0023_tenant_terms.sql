-- 0023: ĐIỀU KHOẢN & CHÍNH SÁCH của phòng tập.
--
-- Chủ phòng soạn, hội viên đọc trong app. Lưu theo PHIÊN BẢN, không sửa đè:
-- khi có tranh chấp ("lúc tôi mua gói, điều khoản đâu có nói vậy") phải trả
-- lời được nội dung ĐANG HIỆU LỰC vào một ngày cụ thể. Sửa đè là mất câu trả
-- lời đó.
--
-- Chỉ văn bản thuần (không HTML): hội viên đọc trên điện thoại, và văn bản
-- thuần không có đường chèn script.

CREATE TABLE tenant_terms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  version      int  NOT NULL CHECK (version > 0),
  content      text NOT NULL CHECK (length(btrim(content)) BETWEEN 20 AND 50000),
  published_by uuid NOT NULL REFERENCES identity(id),
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_terms_version UNIQUE (tenant_id, version)
);

COMMENT ON TABLE tenant_terms IS
  'Điều khoản & chính sách của phòng tập, mỗi lần lưu là một phiên bản mới. Bản hiệu lực = version lớn nhất.';

SELECT enable_tenant_rls('tenant_terms');

-- Chỉ thêm, không sửa / xoá: lịch sử phiên bản là bằng chứng.
REVOKE UPDATE, DELETE, TRUNCATE ON tenant_terms FROM app_rw;
