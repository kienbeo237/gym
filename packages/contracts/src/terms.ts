import { z } from 'zod';

/**
 * Điều khoản & chính sách của phòng tập. Lưu theo phiên bản (không sửa đè) —
 * bản hiệu lực là bản mới nhất. Văn bản thuần, không HTML.
 */

export const TERMS_MAX_CHARS = 50_000;

export const TermsVersion = z.object({
  version: z.number().int(),
  content: z.string(),
  publishedAt: z.string(),
  publishedByName: z.string().nullable(),
});
export type TermsVersion = z.infer<typeof TermsVersion>;

/** Bọc trong object: phòng chưa soạn thì `current` là null, không phải body rỗng. */
export const CurrentTerms = z.object({
  current: TermsVersion.nullable(),
});
export type CurrentTerms = z.infer<typeof CurrentTerms>;

export const TermsVersionSummary = TermsVersion.omit({ content: true }).extend({
  length: z.number().int(),
});
export type TermsVersionSummary = z.infer<typeof TermsVersionSummary>;

export const PublishTermsRequest = z.object({
  content: z
    .string()
    .trim()
    .min(20, 'Nội dung quá ngắn (tối thiểu 20 ký tự)')
    .max(TERMS_MAX_CHARS, `Nội dung quá dài (tối đa ${TERMS_MAX_CHARS.toLocaleString('vi-VN')} ký tự)`),
});
export type PublishTermsRequest = z.infer<typeof PublishTermsRequest>;
