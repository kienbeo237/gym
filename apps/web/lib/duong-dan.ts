/**
 * Đường dẫn quay lại sau đăng nhập (`/login?next=…`) — CHỈ trong cùng trang web.
 *
 * `next` do người khác đặt vào link được: không kiểm là thành lỗi chuyển hướng
 * mở (open redirect) — link /login trông thật, đăng nhập xong bị đưa sang
 * trang giả hỏi lại mật khẩu. Các dạng phải chặn:
 *   https://x.com    tuyệt đối
 *   //x.com          tương đối giao thức — trình duyệt hiểu là host khác
 *   /\x.com          trình duyệt đổi \ thành / -> //x.com
 *   ký tự điều khiển tab / xuống dòng bị trình duyệt bỏ đi, ghép lại thành các dạng trên
 */
export function duongDanTiepTheo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > 512) return null;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return null;
  if (/[\u0000-\u001f\u007f]/.test(raw)) return null;
  // Lớp cuối: phân giải thật với một origin giả, host phải giữ nguyên.
  try {
    const u = new URL(raw, 'http://cung-trang.invalid');
    if (u.origin !== 'http://cung-trang.invalid') return null;
    if (u.pathname === '/login' || u.pathname.startsWith('/login/')) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}
