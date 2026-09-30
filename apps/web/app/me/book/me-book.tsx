'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarCheck, LoaderCircle } from 'lucide-react';
import type { MyPackage } from '@pt/contracts';
import { SlotPicker, type Slot } from '../../../components/slot-picker';
import { goiApi } from '../../../lib/client-api';
import { ngayGioVN, ngayISO } from '../../../lib/format';
import { useAction } from '../../../lib/use-action';

/**
 * Hội viên tự đặt lịch. API tự gắn HLV của hợp đồng, chặn đặt quá số buổi,
 * trùng giờ, ngoài cửa sổ đặt trước — màn này chỉ đưa ra các giờ còn trống.
 */
export function MeBook({ goi, chon }: { goi: MyPackage[]; chon: string }) {
  const router = useRouter();
  const [pkgId, setPkgId] = useState(chon);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [dur, setDur] = useState(60);
  const [note, setNote] = useState('');
  const { busy, loi, chay } = useAction();

  async function dat() {
    if (!slot) return;
    const r = await chay(() =>
      goiApi<{ id: string }>('bookings', {
        method: 'POST',
        body: { memberPackageId: pkgId, startsAt: slot.startsAt, durationMinutes: dur, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    );
    if (r) router.push('/me/schedule?booked=1');
  }

  return (
    <div className="stack mt-16" style={{ gap: 16 }}>
      {goi.length > 1 && (
        <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label="Chọn gói tập">
          {goi.map((p) => (
            <label key={p.id} className="panel row-start" style={{ gap: 10, cursor: 'pointer' }}>
              <input type="radio" name="goi" checked={pkgId === p.id} onChange={() => { setPkgId(p.id); setSlot(null); }} />
              <span style={{ minWidth: 0 }}>
                <span className="strong">{p.name}</span>
                <span className="cell-sub" style={{ display: 'block' }}>
                  Còn {p.sessionsRemaining} buổi · HLV {p.trainerName} · hạn {ngayISO(p.expiresOn)}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}

      <div className="card">
        <div className="card-body">
          <SlotPicker key={pkgId} memberPackageId={pkgId} value={slot} onChange={setSlot} duration={dur} onDurationChange={setDur} />
        </div>
      </div>

      {slot && (
        <div className="card">
          <div className="card-body stack" style={{ gap: 12 }}>
            <p style={{ margin: 0 }}>
              Buổi tập <b>{ngayGioVN(slot.startsAt)}</b> · {dur} phút
            </p>
            <label className="field">
              <span className="field-label">Nhắn HLV <span className="faint">(không bắt buộc)</span></span>
              <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
                placeholder="VD: Hôm nay muốn tập chân" />
            </label>
            {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
            <button type="button" className="btn btn-primary" disabled={busy} onClick={dat}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <CalendarCheck size={16} />} Xác nhận đặt lịch
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
