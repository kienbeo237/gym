'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, CalendarX2, CircleCheck, LoaderCircle, UserX } from 'lucide-react';
import type { BookingItem, CancelBookingResponse } from '@pt/contracts';
import { goiApi } from '../lib/client-api';
import { gioVN, ngayGioVN } from '../lib/format';
import { useAction } from '../lib/use-action';
import { SlotPicker, type Slot } from './slot-picker';

type Mo = 'doi' | 'huy' | 'vang' | null;

/**
 * Ba thao tác trên một buổi ĐANG CHỜ: đổi giờ, huỷ, đánh vắng.
 *
 * `vai` quyết định hai điều mà API cũng kiểm lại: hội viên không có nút đánh
 * vắng, và khi huỷ thì gửi `by` đúng người — MEMBER bị áp chính sách huỷ muộn,
 * PT/STAFF thì không bao giờ trừ buổi.
 */
export function BookingActions({
  booking,
  vai,
}: {
  booking: Pick<BookingItem, 'id' | 'startsAt' | 'endsAt' | 'memberPackageId' | 'status' | 'lateCancelHours'>;
  vai: 'MEMBER' | 'PT' | 'STAFF';
}) {
  const router = useRouter();
  const [mo, setMo] = useState<Mo>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [lyDo, setLyDo] = useState('');
  const [xong, setXong] = useState('');
  const { busy, loi, setLoi, chay } = useAction();

  // Sau khi huỷ, router.refresh() đổi trạng thái buổi — vẫn giữ câu giải thích
  // (có bị trừ buổi hay không) thay vì biến mất ngay.
  if (booking.status !== 'BOOKED' && !xong) return null;
  const { lateCancelHours } = booking;

  const dur = Math.round((new Date(booking.endsAt).getTime() - new Date(booking.startsAt).getTime()) / 60_000);
  const conGio = (new Date(booking.startsAt).getTime() - Date.now()) / 3_600_000;
  const trongKhungMuon = conGio < lateCancelHours;
  const hoiVienKhoaDoi = vai === 'MEMBER' && trongKhungMuon;

  const bat = (m: Mo) => {
    setMo((o) => (o === m ? null : m));
    setSlot(null);
    setLyDo('');
    setLoi('');
  };

  async function doiGio() {
    if (!slot) return;
    const r = await chay(() =>
      goiApi(`bookings/${booking.id}/reschedule`, {
        method: 'POST',
        body: { startsAt: slot.startsAt, ...(lyDo.trim() ? { reason: lyDo.trim() } : {}) },
      }),
    );
    if (r !== undefined) {
      setXong(`Đã đổi sang ${ngayGioVN(slot.startsAt)}.`);
      setMo(null);
      router.refresh();
    }
  }

  async function huy() {
    const r = await chay(() =>
      goiApi<CancelBookingResponse>(`bookings/${booking.id}/cancel`, {
        method: 'POST',
        body: { reason: lyDo.trim(), by: vai },
      }),
    );
    if (r) {
      setXong(r.explanation);
      setMo(null);
      router.refresh();
    }
  }

  async function vang() {
    const r = await chay(() =>
      goiApi<CancelBookingResponse>(`bookings/${booking.id}/no-show`, {
        method: 'POST',
        body: lyDo.trim() ? { note: lyDo.trim() } : {},
      }),
    );
    if (r) {
      setXong(r.explanation);
      setMo(null);
      router.refresh();
    }
  }

  if (xong) {
    return (
      <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}>
        <CircleCheck size={15} /> {xong}
      </p>
    );
  }

  const daQuaGio = conGio < 0;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        {!hoiVienKhoaDoi && (
          <button type="button" className={mo === 'doi' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={mo === 'doi'} onClick={() => bat('doi')}>
            <CalendarClock size={14} /> Đổi giờ
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mo === 'huy'} onClick={() => bat('huy')}>
          <CalendarX2 size={14} /> Huỷ buổi
        </button>
        {vai !== 'MEMBER' && daQuaGio && (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mo === 'vang'} onClick={() => bat('vang')}>
            <UserX size={14} /> Đánh vắng
          </button>
        )}
      </div>

      {hoiVienKhoaDoi && mo === null && (
        <p className="small muted" style={{ margin: 0 }}>
          Còn dưới {lateCancelHours} giờ tới buổi tập nên không tự đổi giờ được — liên hệ phòng tập nếu cần.
        </p>
      )}

      {mo === 'doi' && (
        <div className="panel stack" style={{ gap: 12 }}>
          <p className="small muted" style={{ margin: 0 }}>
            Buổi hiện tại: <b>{ngayGioVN(booking.startsAt)}</b> ({dur} phút). Đổi giờ giữ nguyên buổi, không trừ buổi.
          </p>
          <SlotPicker memberPackageId={booking.memberPackageId} value={slot} onChange={setSlot} duration={dur} fixedDuration />
          {vai !== 'MEMBER' && (
            <label className="field">
              <span className="field-label">Lý do <span className="faint">(không bắt buộc)</span></span>
              <input className="input" value={lyDo} maxLength={500} onChange={(e) => setLyDo(e.target.value)}
                placeholder="VD: HLV bận đột xuất" />
            </label>
          )}
          {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={!slot || busy} onClick={doiGio}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {slot ? `Đổi sang ${gioVN(slot.startsAt)}` : 'Chọn giờ mới'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => bat(null)} disabled={busy}>Thôi</button>
          </div>
        </div>
      )}

      {(mo === 'huy' || mo === 'vang') && (
        <form className="panel stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void (mo === 'huy' ? huy() : vang()); }}>
          <p className="small muted" style={{ margin: 0 }}>
            {mo === 'vang'
              ? 'Ghi VẮNG cho buổi này. Có trừ buổi hay không theo chính sách của gói.'
              : vai === 'MEMBER'
                ? trongKhungMuon
                  ? `Còn dưới ${lateCancelHours} giờ tới buổi tập: đây là huỷ muộn, buổi có thể bị trừ theo chính sách của gói.`
                  : `Huỷ trước ${lateCancelHours} giờ nên không bị trừ buổi.`
                : 'Phòng tập / HLV huỷ thì không bao giờ trừ buổi của hội viên.'}
          </p>
          <label className="field">
            <span className="field-label">
              {mo === 'huy' ? 'Lý do huỷ' : 'Ghi chú'}
              {mo === 'vang' && <span className="faint"> (không bắt buộc)</span>}
            </span>
            <input className="input" value={lyDo} required={mo === 'huy'} minLength={mo === 'huy' ? 3 : undefined}
              maxLength={500} onChange={(e) => setLyDo(e.target.value)}
              placeholder={mo === 'huy' ? 'VD: Bận việc đột xuất' : undefined} />
          </label>
          {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {mo === 'huy' ? 'Xác nhận huỷ' : 'Xác nhận vắng'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => bat(null)} disabled={busy}>Thôi</button>
          </div>
        </form>
      )}
    </div>
  );
}
