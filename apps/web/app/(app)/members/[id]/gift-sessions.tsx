'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Gift, LoaderCircle } from 'lucide-react';
import type { GiftSessionsRequest, GiftSessionsResponse } from '@pt/contracts';
import { goiApi } from '../../../../lib/client-api';
import { useAction } from '../../../../lib/use-action';

const LY_DO_GOI_Y = ['Bù buổi HLV nghỉ', 'Quà sinh nhật', 'Khuyến mãi gia hạn', 'Xin lỗi vì sự cố'];

/**
 * Nút "Tặng" trên một hợp đồng — chỉ hiện cho chủ phòng / quản lý (API cũng
 * chặn). Hợp đồng đã quá hạn thì bắt gia hạn kèm, cùng quy tắc với API, để
 * người bấm biết trước thay vì nhận lỗi.
 */
export function GiftSessions({
  memberId,
  pkg,
  quaHan,
}: {
  memberId: string;
  pkg: { id: string; name: string; code: string; expiresOn: string };
  quaHan: boolean;
}) {
  const router = useRouter();
  const hop = useRef<HTMLDialogElement>(null);
  const [soBuoi, setSoBuoi] = useState(1);
  const [lyDo, setLyDo] = useState('');
  const [giaHan, setGiaHan] = useState(quaHan);
  const [soNgay, setSoNgay] = useState(30);
  const { busy, loi, setLoi, chay } = useAction();

  function mo() {
    setSoBuoi(1);
    setLyDo('');
    setGiaHan(quaHan);
    setSoNgay(30);
    setLoi('');
    hop.current?.showModal();
  }

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    const body: GiftSessionsRequest = {
      sessions: soBuoi,
      reason: lyDo.trim(),
      ...(giaHan ? { extendDays: soNgay } : {}),
    };
    const r = await chay(() =>
      goiApi<GiftSessionsResponse>(`members/${memberId}/packages/${pkg.id}/gift`, { method: 'POST', body }),
    );
    if (r) {
      hop.current?.close();
      router.refresh();
    }
  }

  return (
    <>
      <button type="button" className="btn btn-ghost btn-sm" onClick={mo} title="Tặng thêm buổi cho hợp đồng này">
        <Gift size={14} /> Tặng
      </button>
      <dialog ref={hop} className="dialog" aria-labelledby={`tang-${pkg.id}`}>
        <form className="dialog-body" onSubmit={gui}>
          <div>
            <h2 className="dialog-title" id={`tang-${pkg.id}`}>
              Tặng buổi
            </h2>
            <p className="small muted" style={{ margin: '4px 0 0' }}>
              {pkg.name} · {pkg.code}. Buổi tặng không tính doanh thu; HLV vẫn được tính công dạy.
            </p>
          </div>

          <label className="field">
            <span className="field-label">Số buổi tặng</span>
            <input
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              required
              value={soBuoi}
              onChange={(e) => setSoBuoi(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
            />
            <span className="field-hint">Tối đa 20 buổi mỗi lần.</span>
          </label>

          <label className="field">
            <span className="field-label">Lý do</span>
            <input
              className="input"
              required
              minLength={5}
              maxLength={300}
              list={`ly-do-${pkg.id}`}
              placeholder="VD: Bù buổi HLV nghỉ ngày 12/10"
              value={lyDo}
              onChange={(e) => setLyDo(e.target.value)}
            />
            <datalist id={`ly-do-${pkg.id}`}>
              {LY_DO_GOI_Y.map((x) => (
                <option key={x} value={x} />
              ))}
            </datalist>
            <span className="field-hint">Hội viên thấy lý do này trong lịch sử buổi tập.</span>
          </label>

          <label className="row-start" style={{ gap: 8 }}>
            <input type="checkbox" checked={giaHan} disabled={quaHan} onChange={(e) => setGiaHan(e.target.checked)} />
            <span className="small">
              Gia hạn thêm ngày{quaHan && <span className="text-warning"> — bắt buộc, hợp đồng đã hết hạn</span>}
            </span>
          </label>
          {giaHan && (
            <label className="field">
              <span className="field-label">Số ngày gia hạn</span>
              <input
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                required
                value={soNgay}
                onChange={(e) => setSoNgay(Math.max(1, Math.min(365, Number(e.target.value) || 1)))}
              />
              <span className="field-hint">Tính từ ngày hết hạn hiện tại ({pkg.expiresOn}) hoặc hôm nay nếu đã quá hạn.</span>
            </label>
          )}

          {loi && (
            <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
              {loi}
            </p>
          )}

          <div className="row-start" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={() => hop.current?.close()} disabled={busy}>
              Đóng
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <LoaderCircle size={16} className="spin" /> : <Gift size={16} />} Tặng {soBuoi} buổi
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
