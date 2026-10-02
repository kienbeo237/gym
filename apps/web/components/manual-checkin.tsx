'use client';

import { useState } from 'react';
import { CircleAlert, LoaderCircle, UserCheck } from 'lucide-react';
import type { CheckinResponse } from '@pt/contracts';
import { goiApi } from '../lib/client-api';
import { useAction } from '../lib/use-action';

/** Lý do hay gặp — bấm một lần thay vì gõ trên điện thoại, vẫn sửa được. */
const LY_DO_NHANH = ['Hội viên quên điện thoại', 'Điện thoại hết pin', 'Camera không quét được mã', 'Điện thoại không có mạng'];

/**
 * Điểm danh HỘ — khi hội viên có mặt nhưng không quét được mã QR.
 *
 * Đây là đường bỏ qua chốt kiểm soát duy nhất giữa "HLV bấm đã dạy" và "hoa
 * hồng dạy được ghi", nên giao diện cố ý KHÔNG làm nó nhẹ như một cú bấm:
 *   - ẩn sau một liên kết phụ, mã QR vẫn là đường chính
 *   - bắt buộc lý do (API và CSDL cũng bắt)
 *   - nói thẳng hệ quả trước khi bấm: trừ buổi, ghi tên người bấm, hội viên
 *     thấy lý do trong lịch sử của họ
 *
 * Phương thức (HLV hay phòng tập xác nhận) do API quyết theo vai người bấm,
 * không theo giá trị gửi lên.
 */
export function ManualCheckin({
  bookingId,
  onDone,
}: {
  bookingId: string;
  onDone: (kq: CheckinResponse) => void;
}) {
  const [mo, setMo] = useState(false);
  const [lyDo, setLyDo] = useState('');
  const { busy, loi, setLoi, chay } = useAction();
  const hopLe = lyDo.trim().length >= 5;

  async function gui() {
    if (!hopLe) return;
    const kq = await chay(() =>
      goiApi<CheckinResponse>(`bookings/${bookingId}/checkin`, {
        method: 'POST',
        body: { method: 'PT_CONFIRM', reason: lyDo.trim() },
      }),
    );
    if (kq) onDone(kq);
  }

  if (!mo) {
    return (
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMo(true)}>
        Hội viên không quét được mã?
      </button>
    );
  }

  return (
    <form
      className="panel stack w-full"
      style={{ gap: 12, textAlign: 'left' }}
      onSubmit={(e) => {
        e.preventDefault();
        void gui();
      }}
    >
      <div>
        <div className="strong row-start" style={{ gap: 6 }}>
          <UserCheck size={16} /> Điểm danh hộ
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Chỉ dùng khi hội viên <b>đang có mặt</b>. Buổi tập sẽ bị trừ khỏi gói, tên bạn và lý do được ghi lại, và hội
          viên thấy lý do này trong lịch sử buổi tập của họ.
        </p>
      </div>

      <div className="row-start" style={{ gap: 6, flexWrap: 'wrap' }}>
        {LY_DO_NHANH.map((l) => (
          <button
            key={l}
            type="button"
            className={lyDo === l ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
            aria-pressed={lyDo === l}
            onClick={() => {
              setLyDo(l);
              setLoi('');
            }}
          >
            {l}
          </button>
        ))}
      </div>

      <label className="field">
        <span className="field-label">Lý do</span>
        <input
          className="input"
          value={lyDo}
          required
          minLength={5}
          maxLength={300}
          placeholder="VD: Hội viên quên điện thoại"
          onChange={(e) => {
            setLyDo(e.target.value);
            setLoi('');
          }}
        />
        <span className="field-hint">Ít nhất 5 ký tự.</span>
      </label>

      {loi && (
        <div className="alert" data-tone="danger" role="alert">
          <CircleAlert size={17} />
          <div className="alert-body">{loi}</div>
        </div>
      )}

      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!hopLe || busy}>
          {busy && <LoaderCircle size={14} className="spin" />}
          Xác nhận điểm danh hộ
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={() => {
            setMo(false);
            setLyDo('');
            setLoi('');
          }}
        >
          Đóng
        </button>
      </div>
    </form>
  );
}
