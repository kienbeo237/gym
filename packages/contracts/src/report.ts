import { z } from 'zod';

/** Tháng ở dạng `YYYY-MM`. Luôn hiểu theo giờ Việt Nam. */
export const PeriodMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Tháng phải ở dạng YYYY-MM');

export const DashboardQuery = z.object({
  month: PeriodMonth.optional(),
});
export type DashboardQuery = z.infer<typeof DashboardQuery>;

/**
 * Ba con số tiền, cố ý tách bạch trên cùng một màn hình.
 *
 * `cashIn − cashOut` trả lời "tháng này THU bao nhiêu";
 * `revenueRecognized` trả lời "tháng này LÀM RA bao nhiêu".
 * Chúng khác nhau vì gói bán tháng này được tập dần trong nhiều tháng sau.
 */
export const MonthFigures = z.object({
  month: z.string(),
  cashIn: z.number().int(),
  cashOut: z.number().int(),
  netCash: z.number().int(),
  revenueRecognized: z.number().int(),
  grossSales: z.number().int(),
  packagesSold: z.number().int(),
  newMembers: z.number().int(),
  sessionsTaught: z.number().int(),
  sessionsDeducted: z.number().int(),
});
export type MonthFigures = z.infer<typeof MonthFigures>;

export const DashboardResponse = z.object({
  current: MonthFigures,
  previous: MonthFigures,
  /** Công nợ tại thời điểm xem, không phải của riêng tháng. */
  outstanding: z.object({
    amount: z.number().int(),
    invoiceCount: z.number().int(),
    overdueCount: z.number().int(),
  }),
  /** Doanh thu CHƯA ghi nhận: tiền đã thu cho những buổi chưa tập. */
  deferredRevenue: z.object({
    amount: z.number().int(),
    sessionsOutstanding: z.number().int(),
  }),
  activeMembers: z.number().int(),
  expiringSoon: z.number().int(),
  lowBalance: z.number().int(),
  /** Thời điểm số liệu tổng hợp được làm mới lần cuối. */
  refreshedAt: z.string().nullable(),
});
export type DashboardResponse = z.infer<typeof DashboardResponse>;

export const TrainerReportRow = z.object({
  trainerId: z.string().uuid(),
  trainerCode: z.string(),
  trainerName: z.string(),
  sessionsTaught: z.number().int(),
  sessionsDeducted: z.number().int(),
  revenueRecognized: z.number().int(),
  commissionSale: z.number().int(),
  commissionTeach: z.number().int(),
  commissionTotal: z.number().int(),
  baseSalary: z.number().int(),
  /** Tổng thu nhập dự kiến nếu chốt lương ngay bây giờ. */
  estimatedPay: z.number().int(),
  activeMembers: z.number().int(),
});
export type TrainerReportRow = z.infer<typeof TrainerReportRow>;

export const PackageReportRow = z.object({
  templateId: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  soldCount: z.number().int(),
  grossAmount: z.number().int(),
  discountAmount: z.number().int(),
  netAmount: z.number().int(),
  sessionsSold: z.number().int(),
  sessionsUsed: z.number().int(),
  /** Tỷ lệ buổi đã dùng trên tổng buổi đã bán, phần trăm. */
  usageRate: z.number(),
});
export type PackageReportRow = z.infer<typeof PackageReportRow>;

// ---------------------------------------------------------------------------
// Bảng lương
// ---------------------------------------------------------------------------

export const PayrollStatus = z.enum(['DRAFT', 'CLOSED', 'PAID']);
export type PayrollStatus = z.infer<typeof PayrollStatus>;

export const PayrollLine = z.object({
  id: z.string().uuid().nullable(),
  trainerId: z.string().uuid(),
  trainerCode: z.string(),
  trainerName: z.string(),
  baseSalary: z.number().int(),
  commissionSale: z.number().int(),
  commissionTeach: z.number().int(),
  adjustment: z.number().int(),
  adjustmentNote: z.string().nullable(),
  total: z.number().int(),
  sessionsTaught: z.number().int(),
});
export type PayrollLine = z.infer<typeof PayrollLine>;

export const PayrollResponse = z.object({
  month: z.string(),
  status: PayrollStatus,
  runId: z.string().uuid().nullable(),
  closedAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  lines: z.array(PayrollLine),
  totalPayout: z.number().int(),
  /**
   * Hoa hồng của THÁNG TRƯỚC chưa được trả, sẽ bị cuốn vào kỳ này.
   * Xảy ra khi có lần thu tiền ghi lùi ngày sau khi tháng đó đã chốt.
   */
  carriedOver: z.object({
    amount: z.number().int(),
    entryCount: z.number().int(),
  }),
});
export type PayrollResponse = z.infer<typeof PayrollResponse>;

export const ClosePayrollRequest = z.object({
  month: PeriodMonth,
  adjustments: z
    .array(
      z.object({
        trainerId: z.string().uuid(),
        amount: z.number().int(),
        note: z.string().min(3).max(500),
      }),
    )
    .default([]),
});
export type ClosePayrollRequest = z.infer<typeof ClosePayrollRequest>;

/** Mở lại bảng lương đã chốt (chưa chi). Lý do bắt buộc — vào nhật ký cùng ảnh chụp các con số cũ. */
export const ReopenPayrollRequest = z.object({
  month: PeriodMonth,
  reason: z.string().trim().min(10, 'Ghi rõ lý do (ít nhất 10 ký tự)').max(500),
});
export type ReopenPayrollRequest = z.infer<typeof ReopenPayrollRequest>;
