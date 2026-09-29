import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { COOKIE_ACCESS } from '../../../../lib/session';

/**
 * Cầu nối cho các thao tác chạy từ TRÌNH DUYỆT.
 *
 * Token nằm trong cookie httpOnly nên mã client không đọc được — đó là chủ ý.
 * Nhưng một số thao tác phải chạy ở trình duyệt (tải ảnh thẳng lên S3, điểm
 * danh sau khi quét QR), nên cần một đường chuyển tiếp gắn token hộ.
 *
 * HAI ràng buộc:
 *
 *  1. Đích đến là CỐ ĐỊNH (`API_INTERNAL_URL`), chỉ phần đường dẫn do client
 *     chọn. Cho client chọn cả host là biến chỗ này thành công cụ tấn công nội
 *     bộ — máy chủ Next sẽ gọi hộ tới bất cứ đâu trong mạng riêng.
 *
 *  2. Đường dẫn bị chuẩn hoá và cấm `..`. Không có bước này thì
 *     `/api/proxy/me/../../admin` đi ra ngoài phạm vi dự tính.
 */
const GOC = process.env.API_INTERNAL_URL ?? 'http://localhost:4000/api';

async function chuyenTiep(req: Request, path: string[]): Promise<NextResponse> {
  const duongDan = path.join('/');
  if (duongDan.includes('..') || duongDan.startsWith('/')) {
    return NextResponse.json({ code: 'BAD_PATH' }, { status: 400 });
  }

  const jar = await cookies();
  const token = jar.get(COOKIE_ACCESS)?.value;
  if (!token) return NextResponse.json({ code: 'UNAUTHENTICATED' }, { status: 401 });

  const url = new URL(req.url);
  const res = await fetch(`${GOC}/${duongDan}${url.search}`, {
    method: req.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(req.headers.get('content-type')
        ? { 'content-type': req.headers.get('content-type')! }
        : {}),
    },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text(),
    cache: 'no-store',
  });

  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
  });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
