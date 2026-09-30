'use client';

import { useState } from 'react';
import { LoaderCircle, LogOut } from 'lucide-react';

/**
 * Đăng xuất đi qua route handler của Next: chỉ nó thấy refresh token trong
 * cookie httpOnly, nên chỉ nó thu hồi được token ở API trước khi xoá cookie.
 *
 * Điều hướng bằng window.location thay vì router: bỏ sạch cache của App Router,
 * không để màn cũ còn dữ liệu của phiên vừa đóng.
 */
export function LogoutButton({ className, withLabel }: { className?: string; withLabel?: boolean }) {
  const [busy, setBusy] = useState(false);

  async function dangXuat() {
    setBusy(true);
    try {
      await fetch('/api/session', { method: 'DELETE' });
    } finally {
      window.location.replace('/login');
    }
  }

  return (
    <button
      type="button"
      className={className}
      onClick={() => void dangXuat()}
      disabled={busy}
      title="Đăng xuất"
      aria-label="Đăng xuất"
    >
      {busy ? <LoaderCircle size={17} className="spin" /> : <LogOut size={17} />}
      {withLabel && <span>Đăng xuất</span>}
    </button>
  );
}
