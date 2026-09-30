/**
 * Định dạng hiển thị dùng chung.
 *
 * Mọi mốc giờ đều quy về giờ Việt Nam, không theo giờ máy chủ — máy chủ đặt ở
 * UTC thì sau 17h giờ VN đã sang ngày mới và mọi nhãn "hôm nay" lệch một ngày.
 */
export const TZ = 'Asia/Ho_Chi_Minh';

export const vnd = (n: number) => n.toLocaleString('vi-VN');

/** Số tiền rút gọn cho ô thống kê: 12,5 tr · 1,2 tỷ. Bảng thì luôn dùng số đủ. */
export function vndGon(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toLocaleString('vi-VN', { maximumFractionDigits: 2 })} tỷ`;
  if (a >= 1e6) return `${(n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} tr`;
  return vnd(n);
}

/** Ngày trên tờ lịch VIỆT NAM của một mốc thời gian, dạng YYYY-MM-DD. */
export const ngayVN = (iso: string | Date = new Date()) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });

export const gioVN = (iso: string) =>
  new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

export const ngayGioVN = (iso: string) =>
  new Date(iso).toLocaleString('vi-VN', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export const ngayNgan = (iso: string) =>
  new Date(iso).toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });

/** "2025-03-07" -> "07/03/2025", không qua Date để khỏi lệch múi giờ. */
export const ngayISO = (d: string) =>
  /^\d{4}-\d{2}-\d{2}/.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : d;

export function dichNgay(base: string, soNgay: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + soNgay);
  return d.toISOString().slice(0, 10);
}

/** Chữ cái đầu của hai từ cuối — tên Việt đặt tên gọi ở cuối. */
export function vietTat(ten: string): string {
  const t = ten.trim().split(/\s+/).filter(Boolean);
  if (t.length === 0) return '?';
  const hai = t.length === 1 ? t : [t[t.length - 2]!, t[t.length - 1]!];
  return hai.map((w) => w[0]!.toUpperCase()).join('');
}

const MAU_AVATAR = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6'];

/** Màu cố định theo chuỗi: cùng một người luôn cùng một màu. */
export function mauAvatar(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return MAU_AVATAR[Math.abs(h) % MAU_AVATAR.length]!;
}

export const TEN_VAI_TRO: Record<string, string> = {
  OWNER: 'Chủ phòng',
  ADMIN: 'Quản lý',
  RECEPTION: 'Lễ tân',
  PT: 'Huấn luyện viên',
  MEMBER: 'Hội viên',
};
