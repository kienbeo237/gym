'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { goiApi, thongBaoLoi } from '../../../lib/client-api';

/** Đưa một tin lỗi / bị bỏ qua về hàng chờ. Worker sẽ nhặt trong vài giây. */
export function RetryButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function guiLai() {
    setBusy(true);
    try {
      await goiApi(`notifications/${id}/retry`, { method: 'POST' });
      router.refresh();
    } catch (e) {
      alert(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={guiLai} disabled={busy} title="Gửi lại tin này">
      {busy ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}
      Gửi lại
    </button>
  );
}
