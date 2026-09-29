-- =============================================================================
-- 0007 — Cửa hẹp để gắn một người ĐÃ CÓ định danh vào phòng tập mới.
--
-- VẤN ĐỀ: policy `identity_read` (0005) chỉ cho app_rw thấy định danh đã có
-- tenant_user tại phòng đang mở. Đúng như thiết kế — nhưng nó cũng chặn luôn
-- việc tra cứu khi thêm hội viên mới mà người đó đã là khách của phòng khác:
--   - SELECT theo số điện thoại  -> 0 dòng (dù người đó tồn tại)
--   - INSERT identity mới        -> vỡ UNIQUE trên phone
-- Kết quả là màn "Thêm hội viên" báo "số điện thoại đã tồn tại" trong khi màn
-- tìm kiếm không thấy ai. Chính lớp lỗi "tồn tại nhưng không nhìn thấy".
--
-- CÁCH SỬA: một hàm SECURITY DEFINER trả về ĐÚNG uuid, không trả gì khác.
-- Không có tên, không có email, không có phòng nào khác của người đó. Đây là
-- cửa hẹp nhất đủ để làm việc, và nó nằm trong mã nguồn nên soi lại được —
-- khác hẳn với việc nới policy `identity_read`.
--
-- `SET search_path` là bắt buộc với SECURITY DEFINER: thiếu nó thì người gọi
-- tạo được schema tạm chứa hàm/toán tử trùng tên và chiếm quyền của owner.
-- =============================================================================

CREATE OR REPLACE FUNCTION resolve_or_create_identity(
  p_phone     text,
  p_full_name text,
  p_email     text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM identity WHERE phone = p_phone;
  IF v_id IS NOT NULL THEN
    -- KHÔNG ghi đè full_name/email của người đã có: hồ sơ đó thuộc về chính
    -- họ, không thuộc về phòng tập vừa nhập liệu. Tên hiển thị riêng của phòng
    -- (nếu cần) thì để ở member.note, đừng sửa định danh toàn cục.
    RETURN v_id;
  END IF;

  INSERT INTO identity (phone, full_name, email)
  VALUES (p_phone, p_full_name, p_email)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

REVOKE ALL ON FUNCTION resolve_or_create_identity(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_or_create_identity(text, text, text) TO app_rw;

-- ---------------------------------------------------------------------------
-- Hạn mức gói SaaS, kiểm TRONG transaction tạo.
--
-- Đếm-rồi-tạo ở tầng service thua ở hai request song song: cả hai cùng đọc
-- 49/50 rồi cùng tạo, thành 51. Advisory lock theo (tenant, loại) khoá đúng
-- chỗ hẹp nhất và tự nhả khi transaction kết thúc.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_quota(p_tenant uuid, p_kind text)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_limit int;
  v_used  int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_tenant::text || ':' || p_kind));

  SELECT CASE p_kind WHEN 'member' THEN p.max_members
                     WHEN 'trainer' THEN p.max_trainers END
    INTO v_limit
  FROM tenant_subscription ts JOIN plan p ON p.code = ts.plan_code
  WHERE ts.tenant_id = p_tenant;

  IF v_limit IS NULL THEN RETURN; END IF;   -- không giới hạn, hoặc chưa có gói

  IF p_kind = 'member' THEN
    SELECT count(*) INTO v_used FROM member
     WHERE tenant_id = p_tenant AND status <> 'BANNED';
  ELSE
    SELECT count(*) INTO v_used FROM trainer
     WHERE tenant_id = p_tenant AND status = 'ACTIVE';
  END IF;

  IF v_used >= v_limit THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED:%:%:%', p_kind, v_used, v_limit
      USING ERRCODE = 'check_violation';
  END IF;
END $fn$;

REVOKE ALL ON FUNCTION assert_quota(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assert_quota(uuid, text) TO app_rw;
