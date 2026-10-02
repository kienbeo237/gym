import { z } from 'zod';
import { Money, Pagination, PhoneVN } from './common.js';

export const TrainerLevel = z.enum(['JUNIOR', 'SENIOR', 'MASTER']);
export type TrainerLevel = z.infer<typeof TrainerLevel>;

export const CreateTrainerRequest = z.object({
  phone: PhoneVN,
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional(),
  code: z.string().min(1).max(32).optional(),
  level: TrainerLevel.optional(),
  bio: z.string().max(2000).optional(),
  baseSalary: Money.default(0),
  hiredOn: z.string().date().optional(),
  /**
   * Hoa hồng. Bỏ trống thì PT ăn theo mặc định của phòng.
   * Cả hai loại đều dùng: `salePct` tính trên tiền THỰC THU, `teach*` tính theo
   * buổi đã dạy.
   */
  commission: z
    .object({
      salePct: z.number().min(0).max(100),
      teachMode: z.enum(['FIXED', 'PCT']),
      teachFixedAmount: Money.default(0),
      teachPct: z.number().min(0).max(100).default(0),
    })
    .optional(),
});
export type CreateTrainerRequest = z.infer<typeof CreateTrainerRequest>;

export const UpdateTrainerRequest = CreateTrainerRequest.partial().omit({ phone: true });
export type UpdateTrainerRequest = z.infer<typeof UpdateTrainerRequest>;

export const ListTrainerQuery = Pagination.extend({
  q: z.string().max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'LEFT']).optional(),
});
export type ListTrainerQuery = z.infer<typeof ListTrainerQuery>;

export const TrainerSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  fullName: z.string(),
  phone: z.string(),
  level: z.string().nullable(),
  status: z.string(),
  avatarKey: z.string().nullable(),
  /** Số hội viên đang có gói ACTIVE do PT này phụ trách. */
  activeMembers: z.number().int(),
  /** Buổi đã dạy trong tháng hiện tại (giờ Việt Nam). */
  sessionsThisMonth: z.number().int(),
  /** Doanh thu GHI NHẬN trong tháng — theo buổi đã dùng, không phải tiền đã thu. */
  revenueThisMonth: z.number().int(),
  /** Hoa hồng tháng này, gộp cả hai loại SALE và TEACH. */
  commissionThisMonth: z.number().int(),
});
export type TrainerSummary = z.infer<typeof TrainerSummary>;

/**
 * Một dòng của ô CHỌN huấn luyện viên (bán gói, ...). Cố ý chỉ có tên: HLV
 * cũng dùng ô này, và không được thấy lương, hoa hồng, SĐT của đồng nghiệp
 * như ở TrainerSummary.
 */
export const TrainerOption = z.object({
  id: z.string().uuid(),
  code: z.string(),
  fullName: z.string(),
});
export type TrainerOption = z.infer<typeof TrainerOption>;

// ---------------------------------------------------------------------------

export const AvailabilitySlot = z.object({
  weekday: z.number().int().min(0).max(6), // 0 = Chủ nhật
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
});
export type AvailabilitySlot = z.infer<typeof AvailabilitySlot>;

/**
 * Thay TOÀN BỘ khung giờ của PT, không vá từng khung.
 *
 * Ràng buộc "không chồng giờ" nằm ở DB (excl_availability_overlap), nên sửa
 * từng khung sẽ vỡ ở những thứ tự trung gian hợp lệ về mặt kết quả cuối —
 * ví dụ đổi chỗ hai khung cho nhau. Xoá hết rồi ghi lại trong một transaction
 * thì không có trạng thái trung gian nào để vỡ.
 */
export const SetAvailabilityRequest = z.object({
  slots: z.array(AvailabilitySlot).max(50),
});
export type SetAvailabilityRequest = z.infer<typeof SetAvailabilityRequest>;

/** Hồ sơ đầy đủ để sửa. Tên / SĐT / email thuộc định danh toàn cục — chỉ đọc ở đây. */
export type TrainerDetail = {
  id: string;
  code: string;
  fullName: string;
  phone: string;
  email: string | null;
  level: string | null;
  bio: string | null;
  status: string;
  baseSalary: number;
  hiredOn: string | null;
  leftOn: string | null;
  /**
   * Chính sách hoa hồng riêng MỚI NHẤT (có thể chưa tới ngày hiệu lực — đổi
   * hôm nay thì áp từ ngày mai). null = theo mặc định của phòng.
   */
  commission: {
    salePct: number;
    teachMode: 'FIXED' | 'PCT';
    teachFixedAmount: number;
    teachPct: number;
    effectiveFrom: string;
  } | null;
  availability: AvailabilitySlot[];
  activePackages: number;
};
