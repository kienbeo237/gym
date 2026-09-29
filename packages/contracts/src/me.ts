import { z } from 'zod';

/**
 * Hợp đồng cho app HỘI VIÊN.
 *
 * Không endpoint nào ở đây nhận `memberId` từ client — danh tính lấy từ token
 * (`MemberScopePolicy`). Nhận từ tham số là mở đường cho một hội viên đọc hồ sơ
 * của người khác chỉ bằng cách đổi một chuỗi trên thanh địa chỉ.
 */

export const MyPackage = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  sessionsTotal: z.number().int(),
  sessionsRemaining: z.number().int(),
  sessionsUsed: z.number().int(),
  startsOn: z.string(),
  expiresOn: z.string(),
  /** Số ngày còn lại. Âm nghĩa là đã hết hạn. */
  daysLeft: z.number().int(),
  status: z.string(),
  trainerName: z.string().nullable(),
  /** Còn phải trả cho hợp đồng này. */
  outstanding: z.number().int(),
});
export type MyPackage = z.infer<typeof MyPackage>;

export const MySummary = z.object({
  memberCode: z.string(),
  fullName: z.string(),
  packages: z.array(MyPackage),
  totalSessionsRemaining: z.number().int(),
  totalOutstanding: z.number().int(),
  nextBooking: z
    .object({
      id: z.string().uuid(),
      startsAt: z.string(),
      endsAt: z.string(),
      trainerName: z.string(),
      /** Còn bao nhiêu phút nữa tới giờ. Âm nghĩa là đã qua giờ hẹn. */
      minutesUntil: z.number().int(),
    })
    .nullable(),
  /** Cảnh báo cần gia hạn: gói nào sắp hết buổi hoặc sắp hết hạn. */
  warnings: z.array(
    z.object({
      packageCode: z.string(),
      kind: z.enum(['LOW_SESSIONS', 'EXPIRING', 'EXPIRED', 'USED_UP']),
      message: z.string(),
    }),
  ),
});
export type MySummary = z.infer<typeof MySummary>;

export const MyLedgerQuery = z.object({
  packageId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type MyLedgerQuery = z.infer<typeof MyLedgerQuery>;

export const MyLedgerEntry = z.object({
  id: z.string(),
  packageCode: z.string(),
  delta: z.number().int(),
  reason: z.string(),
  /** Câu tiếng Việt giải thích dòng này — hội viên không đọc mã enum. */
  label: z.string(),
  note: z.string().nullable(),
  at: z.string(),
  /** Số dư của hợp đồng SAU dòng này. */
  balanceAfter: z.number().int(),
});
export type MyLedgerEntry = z.infer<typeof MyLedgerEntry>;

export const MyInvoice = z.object({
  id: z.string().uuid(),
  code: z.string(),
  issuedAt: z.string(),
  totalAmount: z.number().int(),
  paidAmount: z.number().int(),
  outstanding: z.number().int(),
  status: z.string(),
  isInstallment: z.boolean(),
  nextDueDate: z.string().nullable(),
  nextDueAmount: z.number().int().nullable(),
});
export type MyInvoice = z.infer<typeof MyInvoice>;

// ---------------------------------------------------------------------------
// Điểm danh từ điện thoại
// ---------------------------------------------------------------------------

/**
 * Quét mã QR trên màn hình huấn luyện viên.
 *
 * Mã là một ĐƯỜNG DẪN, không phải chuỗi thô: camera mặc định của điện thoại mở
 * được nó thẳng, nên hội viên không phải cài gì và web không cần thư viện quét
 * mã. Trang đích lấy `b` (buổi tập) và `t` (mã) rồi gọi endpoint này.
 */
export const MyCheckinRequest = z.object({
  bookingId: z.string().uuid(),
  token: z.string().min(16).max(200),
});
export type MyCheckinRequest = z.infer<typeof MyCheckinRequest>;

// ---------------------------------------------------------------------------
// Nhật ký tiến độ
// ---------------------------------------------------------------------------

/**
 * Số đo lưu dưới dạng SỐ NGUYÊN nhân 10 ở CSDL; API nhận và trả số thực một
 * chữ số thập phân. Đổi đơn vị ở đúng một tầng — để số thực chạy xuống CSDL là
 * nguồn của những con số không bao giờ cộng đúng.
 */
export const ProgressEntry = z.object({
  id: z.string().uuid(),
  recordedOn: z.string(),
  weightKg: z.number().nullable(),
  bodyFatPct: z.number().nullable(),
  muscleKg: z.number().nullable(),
  note: z.string().nullable(),
  photoFileId: z.string().uuid().nullable(),
  /** Chênh lệch cân nặng so với bản ghi liền trước. */
  weightDelta: z.number().nullable(),
});
export type ProgressEntry = z.infer<typeof ProgressEntry>;

export const SaveProgressRequest = z
  .object({
    recordedOn: z.string().date(),
    weightKg: z.number().min(20).max(400).optional(),
    bodyFatPct: z.number().min(1).max(80).optional(),
    muscleKg: z.number().min(10).max(150).optional(),
    note: z.string().max(1000).optional(),
    photoFileId: z.string().uuid().optional(),
  })
  .refine(
    (v) => v.weightKg != null || v.bodyFatPct != null || v.muscleKg != null || v.photoFileId != null,
    { message: 'Phải nhập ít nhất một số đo hoặc một ảnh' },
  );
export type SaveProgressRequest = z.infer<typeof SaveProgressRequest>;
