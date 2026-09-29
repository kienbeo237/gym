-- =============================================================================
-- 0014 — Phase 5: nhật ký tiến độ của hội viên.
--
-- Đây là dữ liệu NHẠY CẢM NHẤT trong hệ thống: cân nặng, tỷ lệ mỡ, ảnh cơ thể.
-- RLS lo phần "không rò sang phòng tập khác"; phần "không rò sang hội viên
-- khác trong CÙNG phòng" thì RLS không lo được — nó do tầng ứng dụng gác
-- (xem MemberScopePolicy và cổng gác tương ứng).
-- =============================================================================

CREATE TABLE member_progress (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL,
  recorded_on   date NOT NULL,
  -- Đơn vị cố định, lưu số nguyên nhân 10 để tránh số thực:
  --   weight_hg  = kg × 10   (72,5 kg -> 725)
  --   body_fat_pm = % × 10   (18,3 % -> 183)
  -- Số thực trong CSDL là nguồn của những con số không bao giờ cộng đúng.
  weight_hg     int CHECK (weight_hg IS NULL OR weight_hg BETWEEN 200 AND 4000),
  body_fat_pm   int CHECK (body_fat_pm IS NULL OR body_fat_pm BETWEEN 10 AND 800),
  muscle_hg     int CHECK (muscle_hg IS NULL OR muscle_hg BETWEEN 100 AND 1500),
  note          text,
  photo_file_id uuid REFERENCES file_object(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES identity(id),
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_member_progress_anchor UNIQUE (tenant_id, id),
  -- Một hội viên một bản ghi mỗi ngày: đo hai lần trong ngày thì ghi đè, không
  -- sinh hai dòng làm biểu đồ răng cưa.
  CONSTRAINT uq_member_progress_day UNIQUE (member_id, recorded_on),
  -- Bản ghi rỗng hoàn toàn thì vô nghĩa.
  CONSTRAINT member_progress_not_empty CHECK (
    weight_hg IS NOT NULL OR body_fat_pm IS NOT NULL
    OR muscle_hg IS NOT NULL OR photo_file_id IS NOT NULL
  ),
  CONSTRAINT fk_member_progress_member FOREIGN KEY (tenant_id, member_id)
    REFERENCES member (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX ix_member_progress ON member_progress (tenant_id, member_id, recorded_on DESC);

SELECT enable_tenant_rls('member_progress');

-- ---------------------------------------------------------------------------
-- Tệp thuộc về một hội viên cụ thể phải khai đúng chủ.
--
-- `file_object.owner_id` trước đây nhận bất kỳ giá trị nào client gửi lên — đo
-- 29/09/2026: một hội viên xin được URL tải ảnh tiến độ gắn cho ownerId của
-- người khác. Ràng buộc dưới đây không thay được phép kiểm ở tầng ứng dụng
-- (nó không biết ai đang gọi), nhưng chặn được dạng hỏng thứ hai: tệp riêng tư
-- mà KHÔNG khai chủ, tức không ai gác được.
-- ---------------------------------------------------------------------------
-- Dữ liệu ĐANG CÓ vi phạm ràng buộc này — và đó chính là dấu vết của lỗ hổng:
-- tệp riêng tư không khai chủ, nên không quy tắc truy cập nào gác được nó.
--
-- Không XOÁ (tệp vẫn nằm trên S3, xoá dòng là mất dấu khoá vĩnh viễn) mà đánh
-- dấu FAILED: chúng biến mất khỏi mọi đường đọc, và job dọn tệp mồ côi nhặt
-- được. Ràng buộc vì thế chỉ áp cho dòng còn sống.
UPDATE file_object
   SET status = 'FAILED'
 WHERE owner_type IN ('PROGRESS_PHOTO', 'MEMBER_AVATAR')
   AND owner_id IS NULL
   AND status <> 'FAILED';

ALTER TABLE file_object
  ADD CONSTRAINT file_private_needs_owner CHECK (
    status = 'FAILED'
    OR owner_type NOT IN ('PROGRESS_PHOTO', 'MEMBER_AVATAR')
    OR owner_id IS NOT NULL
  );
