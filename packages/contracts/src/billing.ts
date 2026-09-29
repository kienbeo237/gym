import { z } from 'zod';
import { Money, Pagination } from './common.js';
import { PaymentMethod } from './sale.js';

export const InvoiceStatus = z.enum([
  'DRAFT',
  'OPEN',
  'PARTIALLY_PAID',
  'PAID',
  'VOID',
  'REFUNDED',
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const ListInvoiceQuery = Pagination.extend({
  memberId: z.string().uuid().optional(),
  status: InvoiceStatus.optional(),
  /** Chỉ hoá đơn còn nợ — dùng cho màn công nợ. */
  unpaidOnly: z.coerce.boolean().default(false),
  /** Chỉ hoá đơn có đợt trả góp đã quá hạn. */
  overdueOnly: z.coerce.boolean().default(false),
});
export type ListInvoiceQuery = z.infer<typeof ListInvoiceQuery>;

export const InvoiceSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  memberId: z.string().uuid(),
  memberName: z.string(),
  memberCode: z.string(),
  issuedAt: z.string(),
  totalAmount: z.number().int(),
  paidAmount: z.number().int(),
  /** `totalAmount - paidAmount`. Âm nghĩa là thu vượt. */
  outstanding: z.number().int(),
  status: InvoiceStatus,
  isInstallment: z.boolean(),
  /** Số đợt trả góp đã quá hạn mà chưa thu đủ. */
  overdueCount: z.number().int(),
  nextDueDate: z.string().nullable(),
});
export type InvoiceSummary = z.infer<typeof InvoiceSummary>;

export const InvoiceDetail = InvoiceSummary.extend({
  note: z.string().nullable(),
  items: z.array(
    z.object({
      id: z.string().uuid(),
      description: z.string(),
      quantity: z.number().int(),
      unitPrice: z.number().int(),
      amount: z.number().int(),
      memberPackageId: z.string().uuid().nullable(),
      packageCode: z.string().nullable(),
    }),
  ),
  schedule: z.array(
    z.object({
      id: z.string().uuid(),
      seq: z.number().int(),
      dueDate: z.string(),
      amount: z.number().int(),
      paidAmount: z.number().int(),
      status: z.string(),
    }),
  ),
  payments: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.enum(['PAYMENT', 'REFUND']),
      amount: z.number().int(),
      signedAmount: z.number().int(),
      method: PaymentMethod,
      paidAt: z.string(),
      reference: z.string().nullable(),
      receivedByName: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetail>;

export const RecordPaymentRequest = z.object({
  amount: Money.refine((v) => v > 0, 'Số tiền thu phải lớn hơn 0'),
  method: PaymentMethod,
  /** Đợt trả góp được thu. Bỏ trống = thu tự do vào hoá đơn. */
  scheduleId: z.string().uuid().optional(),
  reference: z.string().max(120).optional(),
  paidAt: z.string().datetime().optional(),
  note: z.string().max(1000).optional(),
  /**
   * Chống ghi trùng khi bấm hai lần. Nên là uuid sinh ở client lúc MỞ form,
   * không phải lúc bấm nút — sinh lúc bấm thì mỗi lần bấm một khoá khác nhau
   * và cơ chế này vô nghĩa.
   */
  idempotencyKey: z.string().min(8).max(120).optional(),
  /**
   * Cho phép thu vượt số phải thu. Mặc định CHẶN: gõ nhầm một số 0 là sai lệch
   * gấp mười, và lỗi đó rất khó phát hiện về sau.
   */
  allowOverpay: z.boolean().default(false),
});
export type RecordPaymentRequest = z.infer<typeof RecordPaymentRequest>;

export const RefundRequest = z.object({
  amount: Money.refine((v) => v > 0, 'Số tiền hoàn phải lớn hơn 0'),
  method: PaymentMethod,
  reason: z.string().min(3).max(1000),
  idempotencyKey: z.string().min(8).max(120).optional(),
});
export type RefundRequest = z.infer<typeof RefundRequest>;

export const PaymentResult = z.object({
  paymentId: z.string().uuid(),
  invoiceStatus: InvoiceStatus,
  paidAmount: z.number().int(),
  outstanding: z.number().int(),
  /** Hoa hồng bán hàng phát sinh từ lần thu này (âm nếu là hoàn tiền). */
  commission: z.array(
    z.object({
      trainerId: z.string().uuid(),
      trainerName: z.string(),
      amount: z.number().int(),
      ratePct: z.number().nullable(),
    }),
  ),
});
export type PaymentResult = z.infer<typeof PaymentResult>;
