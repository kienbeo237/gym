import { z } from 'zod';
import { Pagination } from './common.js';

/**
 * Mã mẫu tin NỘI BỘ — giống nhau ở mọi phòng tập.
 *
 * Mỗi phòng có OA riêng nên phải đăng ký mẫu ZNS riêng với Zalo, và Zalo cấp
 * một `provider_tpl_id` KHÁC nhau cho mỗi OA. Bảng `tenant_zns_template` ánh xạ
 * mã nội bộ -> mã Zalo của từng phòng.
 */
export const TemplateCode = z.enum([
  'OTP_LOGIN',
  'CHECKIN_REMAINING',
  'SESSION_DEDUCTED',
  'PACKAGE_LOW_BALANCE',
  'PACKAGE_EXPIRING',
  'MEMBER_INACTIVE',
  'BIRTHDAY_GREETING',
  'PAYMENT_DUE',
]);
export type TemplateCode = z.infer<typeof TemplateCode>;

export const Channel = z.enum(['ZALO_ZNS', 'ZALO_OA', 'SMS', 'EMAIL', 'INAPP']);
export type Channel = z.infer<typeof Channel>;

export const OutboxStatus = z.enum(['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED']);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

// ---- Zalo OA ------------------------------------------------------------------

export const ZaloOaStatus = z.enum(['DISCONNECTED', 'CONNECTED', 'TOKEN_EXPIRED', 'ERROR']);
export type ZaloOaStatus = z.infer<typeof ZaloOaStatus>;

/** Trạng thái kết nối. KHÔNG bao giờ chứa secret hay token — kể cả đã che. */
export type ZaloOaInfo = {
  status: ZaloOaStatus;
  appId: string | null;
  oaId: string | null;
  hasSecret: boolean;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
  /** Địa chỉ phải khai ở mục "Callback URL" của ứng dụng trên Zalo. */
  redirectUri: string;
  /** `log` = môi trường dev: không gọi Zalo thật, tin chỉ ghi ra log. */
  driver: 'http' | 'log';
  /** Đã khai "OA Secret Key" để kiểm chữ ký webhook báo phát chưa. */
  hasWebhookSecret: boolean;
  /** Địa chỉ phải khai ở mục "Webhook" của ứng dụng trên Zalo. */
  webhookUrl: string;
};

export const SaveZaloCredentialsRequest = z.object({
  appId: z.string().trim().regex(/^\d{5,32}$/, 'App ID là dãy số do Zalo cấp'),
  secretKey: z.string().trim().min(8).max(200),
});
export type SaveZaloCredentialsRequest = z.infer<typeof SaveZaloCredentialsRequest>;

export const ZaloCallbackRequest = z.object({
  code: z.string().min(1).max(2000),
  state: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
  oaId: z.string().min(1).max(64),
});
export type ZaloCallbackRequest = z.infer<typeof ZaloCallbackRequest>;

/** "OA Secret Key" ở mục Webhook của ứng dụng Zalo. null = gỡ (tắt nhận báo phát). */
export const SaveZaloWebhookSecretRequest = z.object({
  secretKey: z.string().trim().min(8).max(200).nullable(),
});
export type SaveZaloWebhookSecretRequest = z.infer<typeof SaveZaloWebhookSecretRequest>;

export type TemplateParam = { key: string; label: string; example: string };

export type ZnsTemplateRow = {
  code: TemplateCode;
  name: string;
  description: string;
  params: TemplateParam[];
  providerTplId: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISABLED' | 'NOT_SET';
};

export const UpdateZnsTemplateRequest = z.object({
  providerTplId: z.string().trim().max(64).nullable(),
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'DISABLED']),
}).refine((v) => v.status !== 'APPROVED' || !!v.providerTplId, {
  message: 'Mẫu đã duyệt phải có mã template do Zalo cấp',
  path: ['providerTplId'],
});
export type UpdateZnsTemplateRequest = z.infer<typeof UpdateZnsTemplateRequest>;

// ---- Hộp thư đi -----------------------------------------------------------------

export const ListOutboxQuery = Pagination.extend({
  status: OutboxStatus.optional(),
});
export type ListOutboxQuery = z.infer<typeof ListOutboxQuery>;

export type OutboxRow = {
  id: string;
  channel: Channel;
  templateCode: string;
  templateName: string;
  memberId: string | null;
  memberName: string | null;
  memberCode: string | null;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
  /** Zalo báo hội viên ĐÃ NHẬN tin (webhook). null = chưa có báo phát. */
  deliveredAt: string | null;
  nextAttemptAt: string;
};

export type OutboxStats = {
  /** 30 ngày gần nhất. */
  byStatus: Record<OutboxStatus, number>;
  /** Số tin đã gửi thành công trong tháng hiện tại (theo giờ VN). */
  sentThisMonth: number;
};

// ---- Chiến dịch -------------------------------------------------------------------

export const CampaignTrigger = z.enum([
  'LOW_SESSION_BALANCE',
  'PACKAGE_EXPIRING',
  'INACTIVE_MEMBER',
  'BIRTHDAY',
  'PAYMENT_DUE',
]);
export type CampaignTrigger = z.infer<typeof CampaignTrigger>;

export type CampaignRow = {
  id: string;
  code: string;
  name: string;
  triggerType: CampaignTrigger;
  threshold: number;
  channel: Channel;
  templateCode: string;
  isActive: boolean;
  cooldownDays: number;
  /** Số lần đã bắn trong 30 ngày. */
  sent30d: number;
  lastTriggeredAt: string | null;
};

const CampaignFields = z.object({
  name: z.string().trim().min(2).max(120),
  threshold: z.coerce.number().int().min(0).max(365),
  cooldownDays: z.coerce.number().int().min(0).max(365),
  templateCode: TemplateCode,
  isActive: z.boolean(),
});

export const CreateCampaignRequest = CampaignFields.extend({
  code: z.string().trim().regex(/^[A-Z0-9_]{2,32}$/, 'Mã chỉ gồm chữ in hoa, số và dấu _'),
  triggerType: CampaignTrigger,
});
export type CreateCampaignRequest = z.infer<typeof CreateCampaignRequest>;

export const UpdateCampaignRequest = CampaignFields.partial();
export type UpdateCampaignRequest = z.infer<typeof UpdateCampaignRequest>;

export type CampaignPreview = {
  /** Số người thoả điều kiện ngay lúc này. */
  matched: number;
  /** Trong đó, số người SẼ nhận tin (đã trừ người còn trong thời gian chờ). */
  willSend: number;
  sample: { memberName: string; detail: string }[];
  /** Vì sao chiến dịch CHƯA gửi được dù có người thoả điều kiện (null = sẵn sàng). */
  blockedReason: string | null;
};

export type CampaignRunResult = { campaigns: number; queued: number };
