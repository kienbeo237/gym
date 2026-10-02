import { NextResponse, type NextRequest } from 'next/server';
import type { PlatformSessionResponse, SessionResponse } from '@pt/contracts';
import {
  COOKIE_ACCESS,
  COOKIE_REFRESH,
  datCookiePhien,
  xoaCookiePhien,
  type DuLieuPhien,
} from './lib/session-cookies';

/**
 * TỰ LÀM MỚI PHIÊN: access token sống 15 phút, refresh token 30 ngày (phiên
 * nền tảng: 1 ngày). Trước đây hết 15 phút là phải đăng nhập lại.
 *
 * Làm ở middleware — chạy TRƯỚC mọi trang và mọi route (/api/proxy) — chứ
 * không ở apiFetch: Server Component không đặt được cookie, nên token mới lấy
 * ở đó không lưu lại được cho request sau.
 *
 * Làm mới SỚM 60 giây trước khi hết hạn, để token không chết giữa chừng một
 * trang đang gọi vài API.
 *
 * Nhiều request song song (trang + prefetch) cùng cầm một refresh token: gộp
 * về MỘT lượt gọi API trong tiến trình này. Khác tiến trình thì API có vòng
 * dung sai 30 giây (REUSE_GRACE_MS) — không bị coi là token bị trộm.
 */
export const config = {
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image|favicon.ico|login|api/session).*)'],
};

const API = process.env.API_INTERNAL_URL ?? 'http://localhost:4000/api';
const LAM_MOI_SOM_S = 60;

type Claims = { exp?: number; tid?: string; roles?: string[]; mid?: string };

/**
 * Đọc claim của JWT KHÔNG kiểm chữ ký — chỉ để điều hướng (đã tới lúc làm mới
 * chưa, mở màn nào). Quyền thật API tự kiểm ở mọi request.
 */
function docClaims(token: string | undefined): Claims | null {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Claims;
  } catch {
    return null;
  }
}

function conHan(token: string | undefined): boolean {
  const exp = docClaims(token)?.exp;
  return typeof exp === 'number' && exp - LAM_MOI_SOM_S > Date.now() / 1000;
}

/** `chet`: API từ chối hẳn (hết hạn, bị thu hồi) — khác với lỗi mạng tạm thời. */
type KetQua = { ok: true; phien: DuLieuPhien } | { ok: false; chet: boolean };

const dangLam = new Map<string, Promise<KetQua>>();

async function lamMoi(refreshToken: string, ua: string | null): Promise<KetQua> {
  try {
    const res = await fetch(`${API}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ua ? { 'user-agent': ua } : {}) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, chet: true };
    if (!res.ok) return { ok: false, chet: false };
    const s = (await res.json()) as SessionResponse | PlatformSessionResponse;
    const phien: DuLieuPhien =
      'tenant' in s
        ? { ...s, tenantName: s.tenant.name, roles: s.tenant.roles, platformLevel: null }
        : { ...s, tenantName: 'Quản trị nền tảng', roles: [], platformLevel: s.level };
    return { ok: true, phien };
  } catch {
    return { ok: false, chet: false };
  }
}

/**
 * Chưa đăng nhập mà mở một TRANG -> về /login, nhớ trang đang mở trong `next`.
 *
 * Ca chính: hội viên quét mã QR điểm danh trên điện thoại chưa đăng nhập.
 * Trước đây layout tự redirect('/login') trơn — đăng nhập xong về trang chủ,
 * đường dẫn điểm danh mất, phải quét lại. Làm ở middleware vì đây là nơi DUY
 * NHẤT biết đường dẫn đang mở; layout của Next thì không.
 *
 * Route /api/* không chuyển hướng: gọi từ fetch, cần 401 để tự xử lý, không
 * cần một trang HTML đăng nhập.
 *
 * Origin lấy từ header nginx gửi (Host, X-Forwarded-Proto — deploy/nginx):
 * sau proxy, URL Next tự dựng mang http:// và cổng nội bộ. Next không nhận
 * Location tương đối ở middleware. KHÔNG đọc X-Forwarded-Host: nginx không
 * đặt nó nên giá trị (nếu có) là do client tự gửi.
 */
function veDangNhap(req: NextRequest): NextResponse | null {
  const { pathname, search } = req.nextUrl;
  // /_next, /__nextjs_*: tệp và endpoint nội bộ của Next (kể cả lớp báo lỗi
  // lúc dev) — không phải trang.
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next') || pathname.startsWith('/__next')) return null;
  const dich = new URL('/login', goc(req));
  if (pathname !== '/') dich.searchParams.set('next', pathname + search);
  return NextResponse.redirect(dich, 307);
}

/** Origin công khai (sau nginx) — xem veDangNhap. */
function goc(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || req.nextUrl.protocol.replace(':', '');
  const host = req.headers.get('host') ?? req.nextUrl.host;
  return `${proto}://${host}`;
}

/** Khu vực chỉ dành cho một số vai trò. Phải khớp @Roles của API mà màn đó gọi. */
const KHU_THEO_VAI: { prefix: string; roles: string[] }[] = [
  // HLV không xem lương, hoa hồng, SĐT của đồng nghiệp; danh mục gói là việc
  // của quầy. Ô chọn HLV / gói khi bán gói lấy qua API riêng, không qua màn này.
  { prefix: '/trainers', roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
  { prefix: '/packages', roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
  // Cài đặt phòng (gói dịch vụ, chính sách, Zalo, điều khoản) — API đều chỉ mở
  // cho chủ phòng / quản lý.
  { prefix: '/settings', roles: ['OWNER', 'ADMIN'] },
];

/**
 * Chặn theo quyền TRƯỚC khi render. Làm ở đây chứ không ở layout: Next render
 * layout và page SONG SONG, nên redirect() trong layout không ngăn được page
 * gọi API (rồi lỗi 403 ra màn "Không tải được dữ liệu").
 *
 * - Thiếu vai trò cho một khu vực -> về lịch tập.
 * - Mở /me/* mà token không có hồ sơ hội viên (`mid`) -> REWRITE sang màn giải
 *   thích. Địa chỉ giữ nguyên để đăng nhập lại xong quay về đúng trang (vd. link
 *   QR điểm danh).
 */
function theoQuyen(req: NextRequest, token: string, init?: { request: { headers: Headers } }): NextResponse | null {
  const c = docClaims(token);
  if (!c?.tid) return null; // phiên nền tảng: layout của nó tự xử lý
  const { pathname } = req.nextUrl;
  const trong = (p: string) => pathname === p || pathname.startsWith(p + '/');

  const khu = KHU_THEO_VAI.find((k) => trong(k.prefix));
  if (khu && !(c.roles ?? []).some((r) => khu.roles.includes(r))) {
    return NextResponse.redirect(new URL('/schedule', goc(req)), 307);
  }
  if (trong('/me') && !c.mid) {
    const dich = req.nextUrl.clone();
    dich.pathname = '/chua-co-ho-so';
    dich.search = '';
    return NextResponse.rewrite(dich, init);
  }
  return null;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const rt = req.cookies.get(COOKIE_REFRESH)?.value;
  const at = req.cookies.get(COOKIE_ACCESS)?.value;
  if (!rt && !at) return veDangNhap(req) ?? NextResponse.next();
  if (!rt || conHan(at)) return (at ? theoQuyen(req, at) : null) ?? NextResponse.next();

  let viec = dangLam.get(rt);
  if (!viec) {
    viec = lamMoi(rt, req.headers.get('user-agent'));
    dangLam.set(rt, viec);
    // Giữ kết quả thêm một lúc cho request song song tới muộn.
    void viec.finally(() => setTimeout(() => dangLam.delete(rt), 10_000));
  }
  const kq = await viec;

  if (!kq.ok) {
    // Lỗi mạng: để nguyên, trang tự xử lý như chưa có middleware.
    if (!kq.chet) return NextResponse.next();
    // Phiên đã chết: xoá cookie (thay vì lần nào cũng gọi API làm mới một
    // token đã bị thu hồi) và về /login, nhớ trang đang mở. Route /api/* thì
    // để đi tiếp — không có cookie nó tự trả 401.
    req.cookies.delete(COOKIE_ACCESS);
    req.cookies.delete(COOKIE_REFRESH);
    const res = veDangNhap(req) ?? NextResponse.next({ request: { headers: req.headers } });
    xoaCookiePhien(res.cookies);
    return res;
  }

  // Ghi token mới vào CẢ request đang chạy (trang / route phía sau đọc được
  // ngay) lẫn response (trình duyệt lưu cho các request sau).
  req.cookies.set(COOKIE_ACCESS, kq.phien.accessToken);
  req.cookies.set(COOKIE_REFRESH, kq.phien.refreshToken);
  const init = { request: { headers: req.headers } };
  const res = theoQuyen(req, kq.phien.accessToken, init) ?? NextResponse.next(init);
  datCookiePhien(res.cookies, kq.phien);
  return res;
}
