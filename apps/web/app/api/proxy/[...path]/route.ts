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

  // Đọc dạng BYTE, không phải chữ: `res.text()` giải mã UTF-8 và làm hỏng tệp
  // nhị phân (hoá đơn PDF) — lỗi không báo gì, chỉ ra một tệp không mở được.
  const body = await res.arrayBuffer();
  // 204/205/304 không được mang body — kể cả chuỗi rỗng, Response sẽ ném lỗi.
  if (res.status === 204 || res.status === 205 || res.status === 304) {
    return new NextResponse(null, { status: res.status });
  }
  const headers: Record<string, string> = {
    'content-type': res.headers.get('content-type') ?? 'application/json',
  };
  const disposition = res.headers.get('content-disposition');
  if (disposition) headers['content-disposition'] = disposition;
  return new NextResponse(body, { status: res.status, headers });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
export async function PUT(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
export async function PATCH(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
export async function DELETE(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return chuyenTiep(req, (await ctx.params).path);
}
