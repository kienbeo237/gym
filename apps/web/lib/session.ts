import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

/**
 * Phiên đăng nhập nằm trong cookie httpOnly, KHÔNG nằm trong localStorage.
 *
 * localStorage đọc được bằng JavaScript, nên một lỗi XSS ở bất cứ đâu trong
 * ứng dụng là mất token. Cookie httpOnly thì script không chạm tới được; đổi
 * lại phải tự chống CSRF, ở đây bằng sameSite=strict + việc API chỉ nhận
 * Authorization header (form POST từ site khác không gắn được header).
 *
 * Access token sống 15 phút; middleware.ts tự đổi refresh token lấy token mới
 * trước khi trang đọc tới, nên ở đây cứ coi cookie là đang còn hạn.
 */
import {
  COOKIE_ACCESS,
  COOKIE_NAME,
  COOKIE_PLATFORM,
  COOKIE_ROLES,
  COOKIE_TENANT,
} from './session-cookies';

export {
  COOKIE_ACCESS,
  COOKIE_NAME,
  COOKIE_PLATFORM,
  COOKIE_REFRESH,
  COOKIE_ROLES,
  COOKIE_TENANT,
} from './session-cookies';

export const STAFF_ROLES = ['OWNER', 'ADMIN', 'RECEPTION', 'PT'];

export type Session = {
  accessToken: string;
  tenantName: string;
  fullName: string;
  roles: string[];
  /** Có giá trị = phiên quản trị nền tảng, không thuộc phòng tập nào. */
  platformLevel: string | null;
};

export const isStaff = (s: Session) => s.roles.some((r) => STAFF_ROLES.includes(r));
export const isPlatform = (s: Session) => s.platformLevel !== null;

const THU_TU_CAP = ['SUPPORT', 'OPS', 'SUPER'];
/** Phiên nền tảng có đủ cấp `can` không — chỉ để ẩn nút, API vẫn tự kiểm. */
export const duCap = (s: Session, can: 'SUPPORT' | 'OPS' | 'SUPER') =>
  THU_TU_CAP.indexOf(s.platformLevel ?? '') >= THU_TU_CAP.indexOf(can);

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(COOKIE_ACCESS)?.value;
  if (!accessToken) return null;
  return {
    accessToken,
    tenantName: jar.get(COOKIE_TENANT)?.value ?? '',
    fullName: jar.get(COOKIE_NAME)?.value ?? '',
    roles: (jar.get(COOKIE_ROLES)?.value ?? '').split(',').filter(Boolean),
    platformLevel: jar.get(COOKIE_PLATFORM)?.value || null,
  };
}

export async function requireSession(): Promise<Session> {
  const s = await getSession();
  if (!s) redirect('/login');
  return s;
}

/**
 * Gọi API từ Server Component.
 *
 * Mọi thao tác GHI đều đi qua API NestJS, không dùng Server Action chạm thẳng
 * CSDL: ranh giới transaction và ngữ cảnh tenant chỉ có MỘT nơi cài đặt, và
 * đó là backend.
 */
export async function apiFetch<T>(path: string, session: Session): Promise<T> {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000/api';
  const res = await fetch(base + path, {
    headers: { authorization: `Bearer ${session.accessToken}` },
    cache: 'no-store',
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 404) notFound();
  if (!res.ok) throw new Error(`API ${path} lỗi ${res.status}`);
  return res.json() as Promise<T>;
}
