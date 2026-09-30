'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUpDown, LoaderCircle, X } from 'lucide-react';
import { goiApi, thongBaoLoi } from '../../../../lib/client-api';

/**
 * Gửi yêu cầu chuyển sang một gói. Nền tảng duyệt rồi mới đổi — không tự đổi
 * ngay, vì đổi gói kéo theo giá hoá đơn kỳ sau.
 */
export function PlanRequestButton({ planCode, planName, upgrade }: { planCode: string; planName: string; upgrade: boolean }) {
  const router = useRouter();
  const [mo, setMo] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    try {
      await goiApi('subscription/plan-request', {
        method: 'POST',
        body: { planCode, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      setMo(false);
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
    } finally {
      setBusy(false);
    }
  }

  if (!mo) {
    return (
      <button type="button" className={upgrade ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => setMo(true)}>
        <ArrowUpDown size={14} /> {upgrade ? 'Nâng lên gói này' : 'Chuyển sang gói này'}
      </button>
    );
  }

  return (
    <form className="stack" style={{ gap: 10 }} onSubmit={gui}>
      <label className="field">
        <span className="field-label">
          Lời nhắn <span className="faint">(không bắt buộc)</span>
        </span>
        <input
          className="input"
          value={note}
          maxLength={500}
          autoFocus
          placeholder="VD: Tháng sau mở thêm ca tối"
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {loi && (
        <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
          {loi}
        </p>
      )}
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" />} Gửi yêu cầu {planName}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMo(false)} disabled={busy}>
          Thôi
        </button>
      </div>
    </form>
  );
}

/** Rút lại yêu cầu đang chờ (chỉ được khi chưa ai duyệt). */
export function CancelPlanRequest() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function huy() {
    setBusy(true);
    setLoi('');
    try {
      await goiApi('subscription/plan-request', { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
      setBusy(false);
    }
  }

  return (
    <span className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => void huy()} disabled={busy}>
        {busy ? <LoaderCircle size={14} className="spin" /> : <X size={14} />} Rút lại yêu cầu
      </button>
      {loi && <span className="small text-danger">{loi}</span>}
    </span>
  );
}
