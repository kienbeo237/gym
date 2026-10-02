'use client';

import { useState } from 'react';
import { LoaderCircle, LogOut } from 'lucide-react';

/**
 * Đăng xuất đi qua route handler của Next: chỉ nó thấy refresh token trong
 * cookie httpOnly, nên chỉ nó thu hồi được token ở API trước khi xoá cookie.
 *
 * Điều hướng bằng window.location thay vì router: bỏ sạch cache của App Router,
 * không để màn cũ còn dữ liệu của phiên vừa đóng.
 *
 * `giuTrang`: đăng nhập lại xong quay về đúng trang đang mở (vd. trang điểm
 * danh, khi lỡ đăng nhập nhầm tài khoản).
 */
export function LogoutButton({
  className,
  withLabel,
  label = 'Đăng xuất',
  giuTrang,
}: {
  className?: string;
  withLabel?: boolean;
  label?: string;
  giuTrang?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  async function dangXuat() {
    setBusy(true);
    const dich = giuTrang
      ? `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`
      : '/login';
    try {
      await fetch('/api/session', { method: 'DELETE' });
    } finally {
      window.location.replace(dich);
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => void dangXuat()}
      disabled={busy}
      title={label}
      aria-label={label}
    >
      {busy ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}
      {withLabel && <span>{label}</span>}
    </button>
  );
}
