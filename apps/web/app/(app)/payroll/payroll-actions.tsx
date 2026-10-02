'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, LoaderCircle, Lock, LockOpen, Plus, Trash2, Wallet } from 'lucide-react';
import type { PayrollResponse } from '@pt/contracts';
import { Card } from '../../../components/ui';
import { goiApi } from '../../../lib/client-api';
import { vnd } from '../../../lib/format';
import { useAction } from '../../../lib/use-action';

type DieuChinh = { trainerId: string; amount: number; note: string };

/**
 * Chốt / mở lại / đánh dấu đã chi. Luồng: Tạm tính → Chốt (cố định số, có thể
 * kèm điều chỉnh thưởng/phạt) → Đã chi. Mở lại chỉ khi CHƯA chi; lý do vào
 * nhật ký cùng các con số cũ.
 */
export function PayrollActions({ d, thangNay }: { d: PayrollResponse; thangNay: string }) {
  const router = useRouter();
  const [moLaiMo, setMoLaiMo] = useState(false);
  const [ds, setDs] = useState<DieuChinh[]>([]);
  const [lyDo, setLyDo] = useState('');
  const { busy, loi, setLoi, chay } = useAction();

  const tongDc = ds.reduce((s, x) => s + x.amount, 0);
  const sua = (i: number, p: Partial<DieuChinh>) => {
    setLoi('');
    setDs((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));
  };

  async function chot(e: React.FormEvent) {
    e.preventDefault();
    if (ds.some((x, i) => ds.findIndex((y) => y.trainerId === x.trainerId) !== i)) {
      setLoi('Mỗi huấn luyện viên chỉ một dòng điều chỉnh.');
      return;
    }
    if (ds.some((x) => x.amount === 0 || x.note.trim().length < 3)) {
      setLoi('Mỗi dòng điều chỉnh cần số tiền khác 0 và ghi chú ít nhất 3 ký tự.');
      return;
    }
    const chuaHet =
      d.month >= thangNay ? `\n\nLưu ý: tháng này CHƯA hết — buổi dạy / tiền thu sau lúc chốt sẽ tính sang kỳ sau.` : '';
    if (!confirm(`Chốt bảng lương tháng ${d.month}? Tổng chi ${vnd(d.totalPayout + tongDc)} ₫.${chuaHet}`)) return;
    const r = await chay(() =>
      goiApi('reports/payroll/close', {
        method: 'POST',
        body: { month: d.month, adjustments: ds.map((x) => ({ ...x, note: x.note.trim() })) },
      }),
    );
    if (r !== undefined) router.refresh();
  }

  async function moLai(e: React.FormEvent) {
    e.preventDefault();
    const r = await chay(() => goiApi('reports/payroll/reopen', { method: 'POST', body: { month: d.month, reason: lyDo.trim() } }));
    if (r !== undefined) router.refresh();
  }

  async function daChi() {
    if (!confirm(`Xác nhận đã chi lương tháng ${d.month} (${vnd(d.totalPayout)} ₫)? Sau bước này không mở lại được.`)) return;
    const r = await chay(() => goiApi('reports/payroll/mark-paid', { method: 'POST', body: { month: d.month } }));
    if (r !== undefined) router.refresh();
  }

  if (d.status === 'PAID') {
    return (
      <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}>
        <CircleCheck size={15} /> Đã chi xong. Bảng lương này không sửa được nữa.
      </p>
    );
  }

  if (d.status === 'CLOSED') {
    return (
      <Card title="Thao tác" desc="Số liệu đã cố định. Chi tiền xong thì đánh dấu đã chi.">
        <div className="stack" style={{ gap: 12 }}>
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void daChi()}>
              {busy && !moLaiMo ? <LoaderCircle size={14} className="spin" /> : <Wallet size={14} />} Đánh dấu đã chi
            </button>
            <button type="button" className="btn btn-ghost btn-sm" aria-pressed={moLaiMo}
              onClick={() => { setLoi(''); setMoLaiMo((x) => !x); }}>
              <LockOpen size={14} /> Mở lại để sửa
            </button>
          </div>
          {moLaiMo && (
            <form className="panel stack" style={{ gap: 12 }} onSubmit={moLai}>
              <label className="field">
                <span className="field-label">Lý do mở lại</span>
                <input className="input" required minLength={10} maxLength={500} value={lyDo} onChange={(e) => setLyDo(e.target.value)}
                  placeholder="VD: Quên cộng thưởng doanh số cho HLV Minh" />
                <span className="field-hint">Ghi vào nhật ký kèm số liệu cũ. Ít nhất 10 ký tự.</span>
              </label>
              <div className="row-start" style={{ gap: 8 }}>
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || lyDo.trim().length < 10}>
                  {busy && <LoaderCircle size={14} className="spin" />} Mở lại
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMoLaiMo(false)} disabled={busy}>Đóng</button>
              </div>
            </form>
          )}
          {loi && <p className="small text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card title="Chốt bảng lương" desc="Chốt xong số liệu cố định. Hoa hồng chưa trả của các tháng trước được cuốn vào kỳ này.">
      <form className="stack" style={{ gap: 14 }} onSubmit={chot}>
        <div className="stack" style={{ gap: 8 }}>
          <span className="field-label">Điều chỉnh (thưởng +, phạt −)</span>
          {ds.length === 0 && <span className="small faint">Không có điều chỉnh.</span>}
          {ds.map((x, i) => (
            <div key={i} className="repeat-row" style={{ ['--cols' as string]: 'minmax(0, 1.2fr) 140px minmax(0, 1.6fr) auto' }}>
              <select className="input" aria-label="Huấn luyện viên" value={x.trainerId} onChange={(e) => sua(i, { trainerId: e.target.value })}>
                {d.lines.map((l) => (
                  <option key={l.trainerId} value={l.trainerId}>{l.trainerName}</option>
                ))}
              </select>
              <input className="input tabular" type="number" step={10000} aria-label="Số tiền" value={x.amount}
                onChange={(e) => sua(i, { amount: Math.trunc(Number(e.target.value) || 0) })} />
              <input className="input" aria-label="Ghi chú" maxLength={500} placeholder="Lý do (bắt buộc)" value={x.note}
                onChange={(e) => sua(i, { note: e.target.value })} />
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Xoá dòng"
                onClick={() => setDs((s) => s.filter((_, j) => j !== i))}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={d.lines.length === 0}
              onClick={() =>
                setDs((s) => [
                  ...s,
                  { trainerId: (d.lines.find((l) => !s.some((y) => y.trainerId === l.trainerId)) ?? d.lines[0]!).trainerId, amount: 0, note: '' },
                ])
              }>
              <Plus size={14} /> Thêm điều chỉnh
            </button>
          </div>
        </div>
        <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button type="submit" className="btn btn-primary" disabled={busy || d.lines.length === 0}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Lock size={16} />} Chốt · {vnd(d.totalPayout + tongDc)} ₫
          </button>
          {tongDc !== 0 && <span className="small muted">gồm điều chỉnh {tongDc > 0 ? '+' : ''}{vnd(tongDc)} ₫</span>}
          {loi && <span className="small text-danger" role="alert">{loi}</span>}
        </div>
      </form>
    </Card>
  );
}
