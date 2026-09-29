import { z } from 'zod';
import { Money } from './common.js';

export const PaymentMethod = z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'EWALLET', 'OTHER']);
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const InstallmentInput = z.object({
  dueDate: z.string().date(),
  amount: Money.refine((v) => v > 0, 'Số tiền mỗi đợt phải lớn hơn 0'),
});
export type InstallmentInput = z.infer<typeof InstallmentInput>;

/**
 * Bán một gói tập.
 *
 * Một thao tác này sinh ra BỐN thứ trong cùng một giao dịch: hợp đồng
 * (member_package, đã chụp ảnh giá và số buổi), dòng sổ cái +N buổi, hoá đơn,
 * và tuỳ chọn là kế hoạch trả góp. Tách thành nhiều lời gọi API là mở đường
 * cho trạng thái nửa vời — hợp đồng có mà hoá đơn không, hoặc ngược lại.
 */
export const SellPackageRequest = z
  .object({
    memberId: z.string().uuid(),
    templateId: z.string().uuid(),
    /** PT sẽ DẠY gói này. Gói GYM (tập tự do) thì bỏ trống. */
    trainerId: z.string().uuid().optional(),
    /** PT BÁN, ăn hoa hồng theo tiền thực thu. Bỏ trống thì lấy theo trainerId. */
    soldById: z.string().uuid().optional(),
    discount: Money.default(0),
    startsOn: z.string().date().optional(),
    note: z.string().max(1000).optional(),
    /** Rỗng = trả một lần. Có ≥1 đợt = trả góp, tổng phải bằng tiền phải thu. */
    installments: z.array(InstallmentInput).max(24).default([]),
    /** Tiền đặt cọc / thu ngay lúc ký. */
    initialPayment: z
      .object({
        amount: Money.refine((v) => v > 0, 'Số tiền thu phải lớn hơn 0'),
        method: PaymentMethod,
        reference: z.string().max(120).optional(),
      })
      .optional(),
    idempotencyKey: z.string().min(8).max(120).optional(),
  })
  .refine((v) => !(v.installments.length > 0 && v.installments.length < 2), {
    message: 'Trả góp phải có ít nhất 2 đợt',
    path: ['installments'],
  });
export type SellPackageRequest = z.infer<typeof SellPackageRequest>;

export const SellPackageResponse = z.object({
  memberPackageId: z.string().uuid(),
  packageCode: z.string(),
  invoiceId: z.string().uuid(),
  invoiceCode: z.string(),
  totalAmount: z.number().int(),
  paidAmount: z.number().int(),
  sessionsTotal: z.number().int(),
  expiresOn: z.string(),
  schedule: z.array(
    z.object({
      id: z.string().uuid(),
      seq: z.number().int(),
      dueDate: z.string(),
      amount: z.number().int(),
      status: z.string(),
    }),
  ),
});
export type SellPackageResponse = z.infer<typeof SellPackageResponse>;
