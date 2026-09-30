/**
 * Gọi API từ TRÌNH DUYỆT, qua `/api/proxy` (token nằm ở cookie httpOnly).
 *
 * Ném `Error` mang câu tiếng Việt đọc được: lỗi validate thì lấy câu của trường
 * đầu tiên — "Dữ liệu gửi lên không hợp lệ" không giúp ai sửa được gì.
 */
export async function goiApi<T = unknown>(
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/proxy/${path.replace(/^\//, '')}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Phiên đăng nhập đã hết hạn');
  }
  if (!res.ok) {
    const chiTiet = Array.isArray(data.details) ? (data.details[0] as { message?: string } | undefined) : undefined;
    throw new Error(chiTiet?.message ?? (typeof data.message === 'string' ? data.message : `Lỗi ${res.status}`));
  }
  return data as T;
}

export const thongBaoLoi = (e: unknown) => (e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
