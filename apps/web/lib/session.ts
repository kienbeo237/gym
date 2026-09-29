import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Phiên đăng nhập nằm trong cookie httpOnly, KHÔNG nằm trong localStorage.
 *
 * localStorage đọc được bằng JavaScript, nên một lỗi XSS ở bất cứ đâu trong
 * ứng dụng là mất token. Cookie httpOnly thì script không chạm tới được; đổi
 * lại phải tự chống CSRF, ở đây bằng sameSite=strict + việc API chỉ nhận
 * Authorization header (form POST từ site khác không gắn được header).
 */
export const COOKIE_ACCESS = 'pt_at';
export const COOKIE_REFRESH = 'pt_rt';
export const COOKIE_TENANT = 'pt_tenant';

export type Session = {
  accessToken: string;
  tenantName: string;
};

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  const accessToken = jar.get(COOKIE_ACCESS)?.value;
  if (!accessToken) return null;
  return { accessToken, tenantName: jar.get(COOKIE_TENANT)?.value ?? '' };
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
  if (!res.ok) throw new Error(`API ${path} lỗi ${res.status}`);
  return res.json() as Promise<T>;
}
