import { z } from 'zod';
import { PhoneVN, TenantRole } from './common.js';

/**
 * Đăng nhập HAI BƯỚC, vì một định danh có thể thuộc nhiều phòng tập.
 *
 *   1. /auth/login          -> xác thực người, trả preToken + danh sách phòng
 *   2. /auth/select-tenant  -> chọn phòng, trả access token CÓ tenantId
 *
 * Trước bước 2 chưa có ngữ cảnh tenant nên chưa query được dữ liệu nghiệp vụ nào.
 * Đó là thiết kế, không phải bước thừa: `tenantId` trong token là nguồn sự thật
 * duy nhất cho RLS, và nó phải do máy chủ ký chứ không do subdomain quyết định.
 */

export const LoginRequest = z.object({
  phone: PhoneVN,
  password: z.string().min(6),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const OtpRequest = z.object({ phone: PhoneVN });
export type OtpRequest = z.infer<typeof OtpRequest>;

export const OtpVerifyRequest = z.object({
  phone: PhoneVN,
  code: z.string().length(6),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequest>;

export const TenantOption = z.object({
  tenantId: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  roles: z.array(TenantRole),
});
export type TenantOption = z.infer<typeof TenantOption>;

export const LoginResponse = z.object({
  preToken: z.string(),
  identityId: z.string().uuid(),
  fullName: z.string(),
  tenants: z.array(TenantOption),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const SelectTenantRequest = z.object({ tenantId: z.string().uuid() });
export type SelectTenantRequest = z.infer<typeof SelectTenantRequest>;

export const SessionResponse = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int(),
  tenant: TenantOption,
  identityId: z.string().uuid(),
  fullName: z.string(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

/** Nội dung access token. `tid` là thứ duy nhất RLS tin. */
export type AccessTokenClaims = {
  sub: string;          // identity id
  tid: string;          // tenant id
  roles: TenantRole[];
  mid?: string;         // member id, nếu người này là hội viên tại phòng đó
  trid?: string;        // trainer id, nếu là PT
  iat: number;
  exp: number;
};

/** Token giữa hai bước, KHÔNG mở được dữ liệu nghiệp vụ nào. */
export type PreTokenClaims = {
  sub: string;
  stage: 'SELECT_TENANT';
  iat: number;
  exp: number;
};
