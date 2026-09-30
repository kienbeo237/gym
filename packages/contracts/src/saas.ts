import { z } from 'zod';
import { PhoneVN } from './common.js';
import type { PlatformLevel } from './auth.js';

/**
 * Gói SaaS: phòng tập trả tiền cho NỀN TẢNG (khác hẳn hoá đơn hội viên trả cho
 * phòng tập ở billing.ts).
 *
 * Thu tiền bằng CHUYỂN KHOẢN THỦ CÔNG: nền tảng phát hành hoá đơn kèm nội dung
 * chuyển khoản riêng, phòng tập chuyển, quản trị nền tảng đối chiếu sao kê rồi
 * bấm xác nhận. Không cổng thanh toán nào — ở quy mô vài chục phòng, một người
 * đối soát mỗi sáng rẻ và ít rủi ro hơn tích hợp cổng.
 */

export type TenantStatus = 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CLOSED';
export type SubscriptionStatus = 'TRIALING' | 'ACTIVE' | 'PAST_DUE' | 'CANCELLED';
export type SaasInvoiceStatus = 'PENDING' | 'PAID' | 'WAIVED' | 'VOID';

export type PlanInfo = {
  code: string;
  name: string;
  priceMonthly: number;
  /** null = không giới hạn. */
  maxMembers: number | null;
  maxTrainers: number | null;
  maxMessagesMonth: number | null;
  isPublic: boolean;
};

/** Đã dùng / hạn mức. `limit` null = không giới hạn. */
export type UsageMeter = { used: number; limit: number | null };
export type SaasUsage = { members: UsageMeter; trainers: UsageMeter; messages: UsageMeter };

export type SaasInvoice = {
  id: string;
  periodStart: string;
  periodEnd: string;
  planCode: string;
  planName: string;
  amount: number;
  status: SaasInvoiceStatus;
  dueDate: string;
  transferRef: string;
  paidAmount: number | null;
  confirmedAt: string | null;
  note: string | null;
  createdAt: string;
};

/** Tài khoản nhận tiền của nền tảng — cấu hình bằng biến môi trường SAAS_BANK_*. */
export type PayTo = { bankName: string; accountNo: string; accountName: string } | null;

// ---- Phía phòng tập ----------------------------------------------------------

/** Dải trạng thái trên đầu mọi màn quản lý. Nhẹ — gọi ở layout. */
export type TenantStanding = {
  tenantStatus: TenantStatus;
  statusNote: string | null;
  subscriptionStatus: SubscriptionStatus;
  planName: string;
  paidThrough: string;
  /** Hoá đơn đang mở (nếu có) — để nhắc chủ phòng trước hạn. */
  openInvoice: { id: string; amount: number; dueDate: string; transferRef: string } | null;
  /** Ngày bị tạm khoá nếu vẫn chưa trả (chỉ có khi đang quá hạn). */
  suspendOn: string | null;
};

export type SubscriptionOverview = TenantStanding & {
  planCode: string;
  trialEndsAt: string | null;
  periodStart: string;
  usage: SaasUsage;
  invoices: SaasInvoice[];
  plans: PlanInfo[];
  payTo: PayTo;
  graceDays: number;
  supportContact: string | null;
  /** Yêu cầu đổi gói đang chờ duyệt, hoặc yêu cầu vừa được xử lý gần nhất (30 ngày). */
  planRequest: PlanRequestInfo | null;
};

// ---- Phía nền tảng -----------------------------------------------------------

export type PlatformMe = { identityId: string; fullName: string; level: PlatformLevel };

export type PlatformOverview = {
  tenantsByStatus: Record<string, number>;
  /** Doanh thu định kỳ tháng: tổng giá gói của các phòng đang trả tiền. */
  mrr: number;
  openInvoices: { count: number; amount: number; overdue: number };
  paidThisMonth: number;
  messagesThisMonth: number;
  pendingPlanRequests: number;
  /** Giao dịch ngân hàng chưa khớp được hoá đơn nào và chưa ai xử lý. */
  unmatchedBankTxns: number;
  /** Lần chạy đối soát dữ liệu gần nhất (worker, 6 giờ một lần). null = chưa chạy lần nào. */
  reconciliation: ReconciliationSummary | null;
};

/** Kết quả một lần chạy tám view đối soát. Mọi con số phải bằng 0. */
export type ReconciliationSummary = {
  ranAt: string;
  total: number;
  /** view -> số dòng lệch. */
  counts: Record<string, number>;
  /** view -> vài dòng lệch mẫu (chỉ view có lệch). */
  samples: Record<string, Record<string, unknown>[]>;
  /** view -> lỗi khi chạy (thiếu quyền, đổi tên...). Lỗi cũng là báo động. */
  errors: Record<string, string>;
};

export type PlatformTenantRow = {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  statusNote: string | null;
  createdAt: string;
  planCode: string;
  planName: string;
  subscriptionStatus: SubscriptionStatus;
  paidThrough: string;
  usage: SaasUsage;
  openAmount: number;
};

export type PlatformAuditRow = {
  id: string;
  createdAt: string;
  actorName: string | null;
  tenantId: string | null;
  tenantName: string | null;
  action: string;
  detail: Record<string, unknown>;
  ip: string | null;
};

export type PlatformTenantDetail = PlatformTenantRow & {
  timezone: string;
  suspendKind: 'BILLING' | 'MANUAL' | null;
  trialEndsAt: string | null;
  periodStart: string;
  owners: { fullName: string; phone: string }[];
  invoices: SaasInvoice[];
  audit: PlatformAuditRow[];
};

export type PlatformInvoiceRow = SaasInvoice & {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: TenantStatus;
  bankTxnRef: string | null;
  confirmedByName: string | null;
};

const Note = z.string().trim().max(500);
const NoteRequired = z.string().trim().min(3, 'Ghi rõ lý do (ít nhất 3 ký tự)').max(500);

export const CreateTenantRequest = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'Chỉ chữ thường, số và dấu gạch; 3–40 ký tự'),
  name: z.string().trim().min(2).max(120),
  planCode: z.string().min(1),
  /** 0 = không dùng thử, phát hành hoá đơn kỳ đầu ngay. */
  trialDays: z.coerce.number().int().min(0).max(90),
  ownerPhone: PhoneVN,
  ownerName: z.string().trim().min(2).max(120),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequest>;

export type CreateTenantResult = {
  tenantId: string;
  /** false = số điện thoại đã có tài khoản; người đó dùng mật khẩu hiện có. */
  ownerIsNew: boolean;
  /** Mật khẩu tạm, CHỈ trả một lần khi tạo tài khoản mới. Không lưu ở đâu dạng đọc được. */
  tempPassword: string | null;
};

export const ChangePlanRequest = z.object({ planCode: z.string().min(1), note: Note.optional() });
export type ChangePlanRequest = z.infer<typeof ChangePlanRequest>;

export const ExtendTrialRequest = z.object({ days: z.coerce.number().int().min(1).max(60), note: Note.optional() });
export type ExtendTrialRequest = z.infer<typeof ExtendTrialRequest>;

export const TenantStatusRequest = z.object({ note: NoteRequired });
export type TenantStatusRequest = z.infer<typeof TenantStatusRequest>;

export const IssueInvoiceRequest = z.object({
  /** Bỏ trống = giá gói hiện tại. Khác giá gói (giảm giá, bù trừ) thì phải ghi chú. */
  amount: z.coerce.number().int().min(0).optional(),
  note: Note.optional(),
});
export type IssueInvoiceRequest = z.infer<typeof IssueInvoiceRequest>;

export const ConfirmPaymentRequest = z.object({
  paidAmount: z.coerce.number().int().min(0),
  bankTxnRef: z.string().trim().min(3, 'Nhập mã giao dịch trên sao kê').max(120),
  note: Note.optional(),
});
export type ConfirmPaymentRequest = z.infer<typeof ConfirmPaymentRequest>;

export const SettleNoteRequest = z.object({ note: NoteRequired });
export type SettleNoteRequest = z.infer<typeof SettleNoteRequest>;

// ---- Yêu cầu đổi gói (phase 7b) --------------------------------------------------

export type PlanRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

/** Yêu cầu đổi gói, nhìn từ phía phòng tập. */
export type PlanRequestInfo = {
  id: string;
  fromPlan: string;
  toPlan: string;
  toPlanName: string;
  note: string | null;
  status: PlanRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
};

export const CreatePlanRequest = z.object({ planCode: z.string().min(1), note: Note.optional() });
export type CreatePlanRequest = z.infer<typeof CreatePlanRequest>;

/** Hàng chờ duyệt của nền tảng. */
export type PlatformPlanRequestRow = {
  id: string;
  tenantId: string;
  tenantName: string;
  fromPlan: string;
  fromPlanName: string;
  fromPrice: number;
  toPlan: string;
  toPlanName: string;
  toPrice: number;
  note: string | null;
  status: PlanRequestStatus;
  requestedByName: string;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** Hạn mức của gói đích mà phòng đang VƯỢT (hạ gói khi đang đông). Rỗng = vừa. */
  overLimit: string[];
};

export const DecidePlanRequest = z.object({ note: Note.optional() });
export type DecidePlanRequest = z.infer<typeof DecidePlanRequest>;

// ---- Giao dịch ngân hàng (webhook) -------------------------------------------------

export type BankTxnOutcome = 'MATCHED' | 'NO_MATCH' | 'AMOUNT_MISMATCH' | 'ALREADY_SETTLED' | 'AMBIGUOUS' | 'IGNORED';

export type BankTxnRow = {
  id: string;
  provider: string;
  providerTxnId: string;
  amount: number;
  content: string;
  txnAt: string | null;
  receivedAt: string;
  outcome: BankTxnOutcome;
  invoiceId: string | null;
  invoiceAmount: number | null;
  transferRef: string | null;
  tenantId: string | null;
  tenantName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolveNote: string | null;
};

export const ResolveBankTxnRequest = z.object({ note: NoteRequired });
export type ResolveBankTxnRequest = z.infer<typeof ResolveBankTxnRequest>;

// ---- Tài khoản quản trị nền tảng ----------------------------------------------------

export type PlatformAdminRow = {
  identityId: string;
  fullName: string;
  phone: string;
  level: PlatformLevel;
  createdAt: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
};

const Level = z.enum(['SUPPORT', 'OPS', 'SUPER']);

export const AddPlatformAdminRequest = z.object({
  phone: PhoneVN,
  fullName: z.string().trim().min(2).max(120),
  level: Level,
});
export type AddPlatformAdminRequest = z.infer<typeof AddPlatformAdminRequest>;

export type AddPlatformAdminResult = {
  identityId: string;
  /** Mật khẩu tạm — chỉ khi số điện thoại chưa có mật khẩu. Phải đổi ở lần đăng nhập đầu. */
  tempPassword: string | null;
};

export const ChangeAdminLevelRequest = z.object({ level: Level });
export type ChangeAdminLevelRequest = z.infer<typeof ChangeAdminLevelRequest>;
