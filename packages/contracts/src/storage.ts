import { z } from 'zod';

/**
 * Loại tệp quyết định thư mục, kích thước tối đa và ai được xem.
 *
 * `PROGRESS_PHOTO` là ảnh cơ thể hội viên — dữ liệu nhạy cảm nhất trong hệ
 * thống. Không CDN, không cache, URL hạn cực ngắn.
 */
export const FileOwnerType = z.enum([
  'MEMBER_AVATAR',
  'TRAINER_AVATAR',
  'PROGRESS_PHOTO',
  'INVOICE_PDF',
  'CONTRACT',
  'TENANT_LOGO',
]);
export type FileOwnerType = z.infer<typeof FileOwnerType>;

export const UploadUrlRequest = z.object({
  ownerType: FileOwnerType,
  ownerId: z.string().uuid().optional(),
  /**
   * Chỉ dùng để lấy đuôi tệp. Tên do người dùng đặt KHÔNG bao giờ đi vào khoá
   * S3: nó chứa được `../`, ký tự điều khiển, và tên của người khác.
   */
  fileName: z.string().min(1).max(255),
  mime: z.string().min(3).max(100),
  sizeBytes: z.number().int().min(1),
});
export type UploadUrlRequest = z.infer<typeof UploadUrlRequest>;

export const UploadUrlResponse = z.object({
  fileId: z.string().uuid(),
  uploadUrl: z.string().url(),
  objectKey: z.string(),
  expiresInSeconds: z.number().int(),
});
export type UploadUrlResponse = z.infer<typeof UploadUrlResponse>;

export const FileInfo = z.object({
  id: z.string().uuid(),
  objectKey: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['PENDING', 'CONFIRMED', 'FAILED']),
  createdAt: z.string(),
});
export type FileInfo = z.infer<typeof FileInfo>;

export const DownloadUrlResponse = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int(),
});
export type DownloadUrlResponse = z.infer<typeof DownloadUrlResponse>;

/** Hạn mức theo loại tệp. Ép ở BACKEND — client khai bao nhiêu cũng được. */
export const FILE_RULES: Record<
  FileOwnerType,
  { maxBytes: number; mimes: string[]; downloadTtlSeconds: number }
> = {
  MEMBER_AVATAR: { maxBytes: 5_000_000, mimes: ['image/jpeg', 'image/png', 'image/webp'], downloadTtlSeconds: 900 },
  TRAINER_AVATAR: { maxBytes: 5_000_000, mimes: ['image/jpeg', 'image/png', 'image/webp'], downloadTtlSeconds: 900 },
  // Ảnh tiến độ cơ thể: hạn 60 giây, đủ để trình duyệt tải xong rồi hết hiệu lực.
  PROGRESS_PHOTO: { maxBytes: 15_000_000, mimes: ['image/jpeg', 'image/png', 'image/webp'], downloadTtlSeconds: 60 },
  INVOICE_PDF: { maxBytes: 10_000_000, mimes: ['application/pdf'], downloadTtlSeconds: 300 },
  CONTRACT: { maxBytes: 20_000_000, mimes: ['application/pdf', 'image/jpeg', 'image/png'], downloadTtlSeconds: 300 },
  TENANT_LOGO: { maxBytes: 2_000_000, mimes: ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'], downloadTtlSeconds: 3600 },
};
