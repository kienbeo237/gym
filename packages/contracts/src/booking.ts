import { z } from 'zod';

export const BookingStatus = z.enum([
  'BOOKED',
  'CHECKED_IN',
  'COMPLETED',
  'NO_SHOW',
  'CANCELLED_BY_MEMBER',
  'CANCELLED_BY_PT',
  'CANCELLED_BY_STAFF',
]);
export type BookingStatus = z.infer<typeof BookingStatus>;

export const CreateBookingRequest = z.object({
  memberPackageId: z.string().uuid(),
  /** Bỏ trống thì lấy huấn luyện viên phụ trách hợp đồng. */
  trainerId: z.string().uuid().optional(),
  startsAt: z.string().datetime(),
  /** Mặc định 60 phút. */
  durationMinutes: z.number().int().min(15).max(240).default(60),
  note: z.string().max(500).optional(),
});
export type CreateBookingRequest = z.infer<typeof CreateBookingRequest>;

export const ListBookingQuery = z.object({
  /** Khoảng ngày theo giờ Việt Nam, bao gồm cả hai đầu. */
  from: z.string().date(),
  to: z.string().date(),
  trainerId: z.string().uuid().optional(),
  memberId: z.string().uuid().optional(),
  status: BookingStatus.optional(),
});
export type ListBookingQuery = z.infer<typeof ListBookingQuery>;

export const BookingItem = z.object({
  id: z.string().uuid(),
  startsAt: z.string(),
  endsAt: z.string(),
  status: BookingStatus,
  memberId: z.string().uuid(),
  memberName: z.string(),
  memberCode: z.string(),
  trainerId: z.string().uuid(),
  trainerName: z.string(),
  memberPackageId: z.string().uuid(),
  packageCode: z.string(),
  /** Số buổi còn lại của hợp đồng TẠI THỜI ĐIỂM đọc, không phải lúc đặt lịch. */
  sessionsRemaining: z.number().int(),
  checkinAt: z.string().nullable(),
  checkinMethod: z.string().nullable(),
  /** Buổi này đã trừ vào hợp đồng chưa. */
  deducted: z.boolean(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
});
export type BookingItem = z.infer<typeof BookingItem>;

export const CancelBookingRequest = z.object({
  reason: z.string().min(3).max(500),
  /**
   * Ai huỷ. Quyết định có trừ buổi hay không:
   *   MEMBER — áp chính sách huỷ muộn của gói
   *   PT / STAFF — không bao giờ trừ buổi của hội viên
   */
  by: z.enum(['MEMBER', 'PT', 'STAFF']),
});
export type CancelBookingRequest = z.infer<typeof CancelBookingRequest>;

export const CancelBookingResponse = z.object({
  status: BookingStatus,
  deducted: z.boolean(),
  /** Câu giải thích cho người dùng vì sao bị trừ / không bị trừ. */
  explanation: z.string(),
  sessionsRemaining: z.number().int(),
});
export type CancelBookingResponse = z.infer<typeof CancelBookingResponse>;

// ---------------------------------------------------------------------------
// Điểm danh
// ---------------------------------------------------------------------------

export const CheckinTokenResponse = z.object({
  token: z.string(),
  expiresInSeconds: z.number().int(),
  bookingId: z.string().uuid(),
});
export type CheckinTokenResponse = z.infer<typeof CheckinTokenResponse>;

export const CheckinRequest = z.object({
  /**
   * Mã QR do huấn luyện viên mở buổi sinh ra. Bắt buộc với phương thức QR.
   * Thiếu mã thì phải khai `method` khác và hệ thống ghi lại ai xác nhận.
   */
  token: z.string().min(16).max(200).optional(),
  method: z.enum(['QR', 'PT_CONFIRM', 'MEMBER_CONFIRM', 'ADMIN']).default('QR'),
});
export type CheckinRequest = z.infer<typeof CheckinRequest>;

export const CheckinResponse = z.object({
  bookingId: z.string().uuid(),
  status: BookingStatus,
  sessionsRemaining: z.number().int(),
  sessionsTotal: z.number().int(),
  /** Doanh thu ghi nhận cho buổi này. */
  revenueRecognized: z.number().int(),
  teachCommission: z.number().int(),
  /** Gói sắp hết — dùng để nhắc gia hạn ngay tại quầy. */
  lowBalanceWarning: z.boolean(),
  expiresOn: z.string(),
});
export type CheckinResponse = z.infer<typeof CheckinResponse>;

export const MarkNoShowRequest = z.object({
  note: z.string().max(500).optional(),
});
export type MarkNoShowRequest = z.infer<typeof MarkNoShowRequest>;
