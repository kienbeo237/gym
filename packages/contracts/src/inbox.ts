import { z } from 'zod';

/**
 * Thông báo trong app cho nhân viên (chuông ở góc màn hình). Worker sinh ra —
 * nhắc HLV sắp tới giờ dạy, lịch dạy trong ngày, buổi quá giờ chưa điểm danh.
 * Mỗi người chỉ thấy thông báo của chính mình.
 */

export const STAFF_NOTIFICATION_KINDS = ['PT_UPCOMING', 'PT_AGENDA', 'UNCHECKED'] as const;
export type StaffNotificationKind = (typeof STAFF_NOTIFICATION_KINDS)[number];

export const InboxItem = z.object({
  id: z.string().uuid(),
  kind: z.enum(STAFF_NOTIFICATION_KINDS),
  title: z.string(),
  body: z.string(),
  /** Đường dẫn trong app (vd. /schedule/<id>) — bấm vào thông báo thì tới đó. */
  link: z.string().nullable(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type InboxItem = z.infer<typeof InboxItem>;

export const InboxList = z.object({
  items: z.array(InboxItem),
  /** Tổng số chưa đọc — có thể lớn hơn số dòng trong `items`. */
  unread: z.number().int(),
});
export type InboxList = z.infer<typeof InboxList>;
