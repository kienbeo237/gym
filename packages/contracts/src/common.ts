import { z } from 'zod';

/** Vai trò tại một phòng tập. Thứ tự KHÔNG hàm ý cấp bậc — quyền tra bằng bảng. */
export const TenantRole = z.enum(['OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER']);
export type TenantRole = z.infer<typeof TenantRole>;

/**
 * Chuẩn hoá số điện thoại về E.164.
 *
 * Bắt buộc chuẩn hoá TRƯỚC khi chạm DB: identity.phone là UNIQUE toàn cục, nên
 * '0912345678' và '+84912345678' sẽ thành hai người khác nhau — hỏng im lặng,
 * và rất khó gỡ sau khi đã có dữ liệu thật.
 */
export function normalizePhoneVN(input: string): string {
  const digits = input.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('84')) return `+${digits}`;
  if (digits.startsWith('0')) return `+84${digits.slice(1)}`;
  return `+84${digits}`;
}

export const PhoneVN = z
  .string()
  .min(9)
  .transform(normalizePhoneVN)
  .refine((v) => /^\+[1-9][0-9]{7,14}$/.test(v), 'Số điện thoại không hợp lệ');

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof Pagination>;

export type Paged<T> = {
  items: T[];
  page: number;
  size: number;
  total: number;
};

/** Tiền tệ VND, đơn vị ĐỒNG. Không dùng số thực ở bất cứ đâu chạm tới tiền. */
export const Money = z.coerce.number().int().min(0);

export const ApiErrorShape = z.object({
  code: z.string(),
  message: z.string(),
  traceId: z.string().optional(),
  details: z.unknown().optional(),
});
export type ApiErrorShape = z.infer<typeof ApiErrorShape>;
