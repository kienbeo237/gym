'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Plus, Save, Trash2 } from 'lucide-react';
import type { AvailabilitySlot } from '@pt/contracts';
import { goiApi } from '../../../../lib/client-api';
import { TEN_THU } from '../../../../lib/labels';
import { useAction } from '../../../../lib/use-action';

/** Thứ 2 → Chủ nhật, như lịch treo tường ở Việt Nam. */
const THU_TU = [1, 2, 3, 4, 5, 6, 0];

/**
 * Khung giờ nhận dạy theo tuần. API thay TOÀN BỘ trong một transaction (xem
 * SetAvailabilityRequest), nên ở đây sửa thoải mái rồi lưu một lần.
 * Khung chồng nhau trong cùng ngày: CSDL từ chối, câu lỗi hiện ra.
 */
export function AvailabilityEditor({ trainerId, initial }: { trainerId: string; initial: AvailabilitySlot[] }) {
  const router = useRouter();
  const [ds, setDs] = useState<AvailabilitySlot[]>(initial);
  const [xong, setXong] = useState(false);
  const { busy, loi, chay } = useAction();
  const doi = JSON.stringify(ds) !== JSON.stringify(initial);

  const sua = (i: number, p: Partial<AvailabilitySlot>) => {
    setXong(false);
    setDs((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  };

  async function luu() {
    const sai = ds.find((s) => s.startTime >= s.endTime);
    if (sai) {
      alert(`${TEN_THU[sai.weekday]}: giờ kết thúc phải sau giờ bắt đầu`);
      return;
    }
    const r = await chay(() => goiApi(`trainers/${trainerId}/availability`, { method: 'POST', body: { slots: ds } }));
    if (r !== undefined) {
      setXong(true);
      router.refresh();
    }
  }

  return (
    <div className="stack" style={{ gap: 14 }}>
      {THU_TU.map((wd) => {
        const cua = ds.map((s, i) => ({ s, i })).filter((x) => x.s.weekday === wd);
        return (
          <div key={wd} className="row" style={{ gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <span className="strong" style={{ width: 80, paddingTop: 8 }}>{TEN_THU[wd]}</span>
            <div className="stack" style={{ gap: 6, flex: 1, minWidth: 220 }}>
              {cua.length === 0 && <span className="small faint" style={{ paddingTop: 8 }}>Nghỉ</span>}
              {cua.map(({ s, i }) => (
                <div key={i} className="repeat-row" style={{ ['--cols' as string]: '1fr 1fr auto' }}>
                  <input className="input tabular" type="time" step={900} aria-label={`${TEN_THU[wd]} từ`} value={s.startTime}
                    onChange={(e) => sua(i, { startTime: e.target.value })} />
                  <input className="input tabular" type="time" step={900} aria-label={`${TEN_THU[wd]} đến`} value={s.endTime}
                    onChange={(e) => sua(i, { endTime: e.target.value })} />
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Xoá khung"
                    onClick={() => { setXong(false); setDs((x) => x.filter((_, j) => j !== i)); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={ds.length >= 50}
              onClick={() => { setXong(false); setDs((x) => [...x, { weekday: wd, startTime: cua.length ? '17:00' : '06:00', endTime: cua.length ? '21:00' : '11:00' }]); }}>
              <Plus size={14} /> Khung
            </button>
          </div>
        );
      })}
      <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !doi} onClick={luu}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Lưu lịch nhận dạy
        </button>
        {xong && !doi && <span className="small text-success">Đã lưu.</span>}
        {loi && <span className="small text-danger" role="alert">{loi}</span>}
      </div>
    </div>
  );
}
