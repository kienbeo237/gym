import type { NextResponse } from 'next/server';

type ResponseCookies = NextResponse['cookies'];

/**
 * Tên cookie phiên và cách ĐẶT chúng — một nơi, dùng cho cả lúc đăng nhập
 * (/api/session) lẫn lúc tự làm mới (middleware). Hai nơi tự đặt cookie là hai
 * nơi lệch nhau về thời hạn / cờ bảo mật.
 *
 * Tệp này không import next/headers để middleware dùng được.
 */
export const COOKIE_ACCESS = 'pt_at';
export const COOKIE_REFRESH = 'pt_rt';
export const COOKIE_TENANT = 'pt_tenant';
/**
 * Vai trò, CHỈ để điều hướng (hội viên vào /me, nhân viên vào /members).
 * KHÔNG dùng để phân quyền: cookie do máy chủ Next đặt nhưng phân quyền thật
 * nằm ở claim trong access token mà API tự kiểm.
 */
export const COOKIE_ROLES = 'pt_roles';
/** Tên hiển thị trên khung giao diện. Không phải bí mật, không dùng cho quyền. */
export const COOKIE_NAME = 'pt_name';
/**
 * Cấp quản trị nền tảng của phiên hiện tại (SUPPORT/OPS/SUPER), rỗng với phiên
 * phòng tập. Cũng CHỈ để điều hướng và ẩn nút — API kiểm cấp trong token VÀ
 * cấp đang có trong CSDL ở mỗi thao tác.
 */
export const COOKIE_PLATFORM = 'pt_pa';

export const TAT_CA_COOKIE_PHIEN = [
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  COOKIE_TENANT,
  COOKIE_ROLES,
  COOKIE_NAME,
  COOKIE_PLATFORM,
];

export type DuLieuPhien = {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  tenantName?: string;
  fullName?: string;
  roles?: string[];
  platformLevel?: string | null;
};

const CAP_HOP_LE = ['SUPPORT', 'OPS', 'SUPER'];
const NGAY = 24 * 3600;

export function datCookiePhien(jar: ResponseCookies, p: DuLieuPhien): void {
  const secure = process.env.NODE_ENV === 'production';
  const cap = CAP_HOP_LE.includes(p.platformLevel ?? '') ? p.platformLevel! : '';
  // Phiên nền tảng: refresh token sống 1 ngày ở API — cookie không sống lâu hơn.
  const song = cap ? NGAY : 30 * NGAY;

  jar.set(COOKIE_ACCESS, p.accessToken, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: p.expiresIn ?? 900 });
  jar.set(COOKIE_REFRESH, p.refreshToken, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: song });
  // Vai trò: CHỈ để điều hướng. Không httpOnly vì không phải bí mật, và sửa nó
  // cũng vô ích — phân quyền thật nằm ở claim trong access token mà API tự kiểm.
  jar.set(COOKIE_ROLES, (p.roles ?? []).join(','), { sameSite: 'strict', secure, path: '/', maxAge: song });
  // Phiên nền tảng thì ghi cấp; phiên phòng tập thì XOÁ cấp của phiên trước —
  // cùng trình duyệt có thể vừa đăng xuất khỏi màn nền tảng.
  jar.set(COOKIE_PLATFORM, cap, { sameSite: 'strict', secure, path: '/', maxAge: cap ? song : 0 });
  // Tên phòng và tên người KHÔNG httpOnly: chỉ để hiển thị, không phải bí mật.
  jar.set(COOKIE_TENANT, p.tenantName ?? '', { sameSite: 'strict', secure, path: '/', maxAge: song });
  jar.set(COOKIE_NAME, p.fullName ?? '', { sameSite: 'strict', secure, path: '/', maxAge: song });
}

export function xoaCookiePhien(jar: ResponseCookies): void {
  for (const c of TAT_CA_COOKIE_PHIEN) jar.set(c, '', { path: '/', maxAge: 0 });
}
