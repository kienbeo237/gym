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
  /** Lý do điểm danh hộ (PT_CONFIRM / ADMIN); null với QR. */
  checkinNote: z.string().nullable(),
  /** Buổi này đã trừ vào hợp đồng chưa. */
  deducted: z.boolean(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  /**
   * Khung huỷ muộn (giờ) của hợp đồng — đã gộp chính sách gói và phòng. Để màn
   * hình báo trước "huỷ bây giờ sẽ bị trừ buổi" thay vì chỉ báo sau khi huỷ.
   */
  lateCancelHours: z.number().int(),
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
  /**
   * BẮT BUỘC với điểm danh hộ (PT_CONFIRM / ADMIN): vì sao không quét được mã.
   * Ghi vào buổi tập và vào lịch sử hội viên nhìn thấy — đó là chốt đối soát
   * thay cho mã QR.
   */
  reason: z.string().trim().min(5).max(300).optional(),
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

// ---- Chính sách đặt lịch của phòng (Cài đặt → Đặt lịch) -----------------------

export type BookingPolicy = {
  lateCancelHours: number;
  lateCancelDeducts: boolean;
  noShowDeducts: boolean;
  bookingWindowDays: number;
  checkinGraceMinutes: number;
  /** Máy tự đánh vắng khi cửa sổ điểm danh đã đóng. Tắt mặc định — đây là thao tác trừ buổi. */
  autoNoShow: boolean;
  /** Số phút sau giờ bắt đầu thì cửa sổ điểm danh đóng (= ân hạn + 240). Chỉ đọc. */
  checkinWindowCloseMinutes: number;
};

export const UpdateBookingPolicy = z.object({
  lateCancelHours: z.number().int().min(0).max(168),
  lateCancelDeducts: z.boolean(),
  noShowDeducts: z.boolean(),
  bookingWindowDays: z.number().int().min(1).max(365),
  checkinGraceMinutes: z.number().int().min(0).max(240),
  autoNoShow: z.boolean(),
});
export type UpdateBookingPolicy = z.infer<typeof UpdateBookingPolicy>;

// ---- Khung giờ trống (hội viên tự đặt, lễ tân đặt nhanh) ------------------------

export const AvailableSlotsQuery = z.object({
  memberPackageId: z.string().uuid(),
  /** Ngày đầu (giờ Việt Nam). */
  from: z.string().date(),
  days: z.coerce.number().int().min(1).max(14).default(7),
  durationMinutes: z.coerce.number().int().min(15).max(240).default(60),
  /** Bỏ trống = huấn luyện viên phụ trách hợp đồng. Hội viên không chọn được người khác. */
  trainerId: z.string().uuid().optional(),
});
export type AvailableSlotsQuery = z.infer<typeof AvailableSlotsQuery>;

export type AvailableSlots = {
  trainerId: string;
  trainerName: string;
  durationMinutes: number;
  /**
   * HLV đã khai khung giờ nhận dạy chưa. Chưa khai thì gợi ý theo giờ mở cửa
   * mặc định (06:00–21:00) — đặt ngoài khung đó vẫn được, như API đặt lịch.
   */
  hasAvailability: boolean;
  /** Hợp đồng còn đặt thêm được bao nhiêu buổi (còn lại − đã đặt chưa tập). */
  bookableSessions: number;
  days: { date: string; slots: { startsAt: string; endsAt: string }[] }[];
};

/**
 * Đổi giờ một buổi ĐANG CHỜ. Giữ nguyên buổi (không huỷ + đặt lại) nên không
 * bao giờ trừ buổi. Hội viên chỉ đổi được khi còn ngoài khung huỷ muộn — trong
 * khung đó thì đổi lịch chính là huỷ muộn trá hình.
 */
export const RescheduleBookingRequest = z.object({
  startsAt: z.string().datetime(),
  /** Bỏ trống = giữ nguyên thời lượng cũ. */
  durationMinutes: z.number().int().min(15).max(240).optional(),
  reason: z.string().trim().max(500).optional(),
});
export type RescheduleBookingRequest = z.infer<typeof RescheduleBookingRequest>;

export type RescheduleBookingResponse = { id: string; startsAt: string; endsAt: string };
