import { z } from 'zod';
import { PhoneVN, Pagination } from './common.js';

export const CreateMemberRequest = z.object({
  phone: PhoneVN,
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional(),
  code: z.string().min(1).max(32).optional(),   // bỏ trống thì hệ thống tự sinh
  dob: z.string().date().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  source: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

export const ListMemberQuery = Pagination.extend({
  q: z.string().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BANNED']).optional(),
  trainerId: z.string().uuid().optional(),
});
export type ListMemberQuery = z.infer<typeof ListMemberQuery>;

export const MemberSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  fullName: z.string(),
  phone: z.string(),
  status: z.string(),
  activePackages: z.number().int(),
  sessionsRemaining: z.number().int(),
  nextBookingAt: z.string().nullable(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;

/** Một hợp đồng của hội viên, nhìn từ phía nhân viên. */
export type MemberPackageRow = {
  id: string;
  code: string;
  name: string;
  kind: string;
  status: string;
  /** Số buổi MUA theo hợp đồng. */
  sessionsTotal: number;
  /** Số buổi được TẶNG thêm. Tổng được dùng = sessionsTotal + sessionsBonus. */
  sessionsBonus: number;
  sessionsRemaining: number;
  /** Buổi đã đặt mà chưa tập — tính vào "còn đặt thêm được". */
  sessionsBooked: number;
  startsOn: string;
  expiresOn: string;
  trainerId: string | null;
  trainerName: string | null;
  outstanding: number;
};

export type MemberDetail = {
  id: string;
  code: string;
  fullName: string;
  phone: string;
  email: string | null;
  dob: string | null;
  gender: string | null;
  status: string;
  source: string | null;
  note: string | null;
  joinedAt: string;
  packages: MemberPackageRow[];
};

/**
 * Sửa hồ sơ tại PHÒNG NÀY. Họ tên / SĐT thuộc định danh toàn cục (người này có
 * thể là hội viên ở phòng khác) nên không sửa ở đây.
 */
export const UpdateMemberRequest = z.object({
  dob: z.string().date().nullable().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).nullable().optional(),
  source: z.string().max(40).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BANNED']).optional(),
});
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequest>;

/**
 * Tặng buổi cho một hợp đồng. Chỉ chủ phòng / quản lý. Lý do bắt buộc — CSDL
 * cũng chặn (ledger_bonus_accountable). Hợp đồng đã hết hạn thì phải gia hạn
 * kèm, không thì buổi tặng không dùng được.
 */
export const GiftSessionsRequest = z.object({
  sessions: z.number().int().min(1).max(20),
  reason: z.string().trim().min(5).max(300),
  /** Gia hạn thêm N ngày, tính từ max(hạn hiện tại, hôm nay). */
  extendDays: z.number().int().min(1).max(365).optional(),
});
export type GiftSessionsRequest = z.infer<typeof GiftSessionsRequest>;

export const GiftSessionsResponse = z.object({
  memberPackageId: z.string().uuid(),
  sessionsBonus: z.number().int(),
  sessionsRemaining: z.number().int(),
  expiresOn: z.string(),
});
export type GiftSessionsResponse = z.infer<typeof GiftSessionsResponse>;
