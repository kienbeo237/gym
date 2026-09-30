import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { COOKIE_REFRESH, datCookiePhien, xoaCookiePhien } from '../../../lib/session-cookies';

/**
 * Cầu nối giữa trình duyệt và API: nhận kết quả đăng nhập rồi đặt token vào
 * cookie httpOnly. Trình duyệt không bao giờ giữ token trong JavaScript.
 *
 * Route handler này chạy trên MÁY CHỦ Next, nên nó là nơi duy nhất thấy token
 * ở dạng thô.
 */
export async function POST(req: Request): Promise<NextResponse> {
  const body = (await req.json()) as {
    accessToken?: string;
    refreshToken?: string;
    tenantName?: string;
    fullName?: string;
    roles?: string[];
    expiresIn?: number;
    platformLevel?: string;
  };
  if (!body.accessToken || !body.refreshToken) {
    return NextResponse.json({ error: 'THIEU_TOKEN' }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });
  datCookiePhien(res.cookies, { ...body, accessToken: body.accessToken, refreshToken: body.refreshToken });
  return res;
}

/**
 * Đăng xuất: thu hồi refresh token ở API rồi mới xoá cookie.
 *
 * Chỉ xoá cookie thì refresh token vẫn sống thêm 30 ngày ở máy chủ — ai đã
 * chép được nó (máy dùng chung, bản sao lưu trình duyệt) vẫn xin được token
 * mới. Lỗi mạng khi thu hồi không chặn việc đăng xuất: cookie vẫn phải đi.
 */
export async function DELETE(): Promise<NextResponse> {
  const refreshToken = (await cookies()).get(COOKIE_REFRESH)?.value;
  if (refreshToken) {
    const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000/api';
    await fetch(`${base}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
  }

  const res = NextResponse.json({ ok: true });
  xoaCookiePhien(res.cookies);
  return res;
}
