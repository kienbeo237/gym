import { z } from 'zod';
import { Money, Pagination } from './common.js';

export const PackageKind = z.enum(['PT', 'GYM', 'COMBO', 'CLASS']);
export type PackageKind = z.infer<typeof PackageKind>;

/**
 * Ba ô chính sách dưới đây để `null` nghĩa là "theo mặc định của phòng", KHÔNG
 * phải "không áp dụng". Phân giải bằng hàm resolve_booking_policy() ở CSDL —
 * đừng COALESCE lại ở tầng ứng dụng, hai chỗ sẽ trôi khỏi nhau.
 */
const ChinhSachGhiDe = {
  lateCancelHours: z.number().int().min(0).max(168).nullable().optional(),
  lateCancelDeducts: z.boolean().nullable().optional(),
  noShowDeducts: z.boolean().nullable().optional(),
};

export const CreatePackageRequest = z.object({
  code: z.string().min(1).max(32),
  name: z.string().min(2).max(160),
  kind: PackageKind,
  sessions: z.number().int().min(1).max(1000),
  validDays: z.number().int().min(1).max(3650),
  price: Money,
  description: z.string().max(2000).optional(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  ...ChinhSachGhiDe,
});
export type CreatePackageRequest = z.infer<typeof CreatePackageRequest>;

/**
 * `code` không sửa được sau khi tạo: nó là khoá nghiệp vụ hiển thị trên hợp
 * đồng đã in và đã gửi cho khách.
 *
 * `sessions`/`price` thì sửa được, nhưng CHỈ ảnh hưởng gói bán về sau —
 * member_package đã chụp ảnh giá và số buổi tại thời điểm bán.
 */
export const UpdatePackageRequest = CreatePackageRequest.partial().omit({ code: true }).extend({
  isActive: z.boolean().optional(),
});
export type UpdatePackageRequest = z.infer<typeof UpdatePackageRequest>;

export const ListPackageQuery = Pagination.extend({
  q: z.string().max(120).optional(),
  kind: PackageKind.optional(),
  includeInactive: z.coerce.boolean().default(false),
});
export type ListPackageQuery = z.infer<typeof ListPackageQuery>;

export const PackageSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  kind: PackageKind,
  sessions: z.number().int(),
  validDays: z.number().int(),
  price: z.number().int(),
  /** Giá mỗi buổi, làm tròn. Chỉ để hiển thị — tính tiền dùng giá gói. */
  pricePerSession: z.number().int(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  /** Mô tả hiển thị cho khách (tuỳ chọn). */
  description: z.string().nullable(),
  /** Số hợp đồng đã bán từ mẫu này. Khác 0 thì không xoá được. */
  soldCount: z.number().int(),
  /** Chính sách hiệu lực sau khi gộp mặc định của phòng. */
  effectivePolicy: z.object({
    lateCancelHours: z.number().int(),
    lateCancelDeducts: z.boolean(),
    noShowDeducts: z.boolean(),
    inheritedFields: z.array(z.string()),
  }),
});
export type PackageSummary = z.infer<typeof PackageSummary>;
