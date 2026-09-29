import { NextResponse } from 'next/server';
import { COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_ROLES, COOKIE_TENANT } from '../../../lib/session';

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
    roles?: string[];
    expiresIn?: number;
  };
  if (!body.accessToken || !body.refreshToken) {
    return NextResponse.json({ error: 'THIEU_TOKEN' }, { status: 400 });
  }

  const res = NextResponse.json({ ok: true });
  const secure = process.env.NODE_ENV === 'production';
  res.cookies.set(COOKIE_ACCESS, body.accessToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: body.expiresIn ?? 900,
  });
  res.cookies.set(COOKIE_REFRESH, body.refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  // Vai trò: CHỈ để điều hướng (hội viên vào /me, nhân viên vào /members).
  // Không httpOnly vì không phải bí mật, và sửa nó cũng vô ích — phân quyền
  // thật nằm ở claim trong access token mà API tự kiểm.
  res.cookies.set(COOKIE_ROLES, (body.roles ?? []).join(','), {
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  // Tên phòng KHÔNG httpOnly: chỉ để hiển thị, không phải bí mật.
  res.cookies.set(COOKIE_TENANT, body.tenantName ?? '', {
    sameSite: 'strict',
    secure,
    path: '/',
    maxAge: 30 * 24 * 3600,
  });
  return res;
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true });
  for (const c of [COOKIE_ACCESS, COOKIE_REFRESH, COOKIE_TENANT, COOKIE_ROLES]) {
    res.cookies.set(c, '', { path: '/', maxAge: 0 });
  }
  return res;
}
