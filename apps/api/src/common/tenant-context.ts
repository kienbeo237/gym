import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantRole } from '@pt/contracts';

/**
 * Ngữ cảnh của request hiện tại, đi xuyên mọi lời gọi async mà không phải
 * truyền tay qua từng tầng.
 *
 * Nguồn duy nhất: claim trong access token đã ký (TenantInterceptor nạp vào).
 * KHÔNG bao giờ lấy từ subdomain, header hay query param — những thứ đó người
 * gọi sửa được.
 */
export type RequestContext = {
  tenantId: string;
  identityId: string;
  roles: TenantRole[];
  /** Hồ sơ hội viên của chính người này tại phòng đang mở (nếu có). */
  memberId?: string;
  /** Hồ sơ huấn luyện viên của chính người này (nếu có). */
  trainerId?: string;
  requestId: string;
};

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext | undefined {
  return requestContext.getStore();
}

export function requireContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) {
    // Lỗi lập trình, không phải lỗi người dùng: có endpoint nghiệp vụ nào đó
    // chạy ngoài TenantInterceptor. Ném thẳng còn hơn âm thầm trả 0 dòng.
    throw new Error('TENANT_CONTEXT_MISSING');
  }
  return ctx;
}
