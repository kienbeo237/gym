'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Info, LoaderCircle, Save, UserPlus } from 'lucide-react';
import type { TrainerDetail } from '@pt/contracts';
import { Alert, Card } from '../../../components/ui';
import { goiApi } from '../../../lib/client-api';
import { ngayISO, vnd } from '../../../lib/format';
import { useAction } from '../../../lib/use-action';
import { DatePicker } from '../../../components/date-picker';

type HoaHong = { salePct: number; teachMode: 'FIXED' | 'PCT'; teachFixedAmount: number; teachPct: number };

const so = (v: string) => Math.max(0, Number(v) || 0);

/**
 * Thêm / sửa huấn luyện viên. Sửa thì họ tên, SĐT, email chỉ đọc (định danh
 * toàn hệ thống). Hoa hồng đổi hôm nay áp từ NGÀY MAI — hoa hồng đã tính của
 * những ngày trước giữ nguyên căn cứ.
 */
export function TrainerForm({ trainer }: { trainer?: TrainerDetail }) {
  const router = useRouter();
  const sua = !!trainer;
  const [v, setV] = useState({
    phone: trainer?.phone ?? '',
    fullName: trainer?.fullName ?? '',
    email: trainer?.email ?? '',
    level: trainer?.level ?? '',
    bio: trainer?.bio ?? '',
    baseSalary: trainer?.baseSalary ?? 0,
    hiredOn: trainer?.hiredOn ?? '',
  });
  const hhGoc: HoaHong | null = trainer?.commission
    ? {
        salePct: trainer.commission.salePct,
        teachMode: trainer.commission.teachMode,
        teachFixedAmount: trainer.commission.teachFixedAmount,
        teachPct: trainer.commission.teachPct,
      }
    : null;
  const [rieng, setRieng] = useState(!!hhGoc);
  const [hh, setHh] = useState<HoaHong>(hhGoc ?? { salePct: 5, teachMode: 'FIXED', teachFixedAmount: 100_000, teachPct: 0 });
  const [xong, setXong] = useState('');
  const { busy, loi, chay } = useAction();

  const dat = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setXong('');
    setV((s) => ({ ...s, [k]: k === 'baseSalary' ? Math.trunc(so(e.target.value)) : e.target.value }));
  };
  const datHh = <K extends keyof HoaHong>(k: K, val: HoaHong[K]) => {
    setXong('');
    setHh((s) => ({ ...s, [k]: val }));
  };
  const hhDoi = rieng && JSON.stringify(hh) !== JSON.stringify(hhGoc);

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    const chung = {
      ...(v.level ? { level: v.level } : {}),
      ...(v.bio.trim() ? { bio: v.bio.trim() } : {}),
      baseSalary: v.baseSalary,
      ...(v.hiredOn ? { hiredOn: v.hiredOn } : {}),
    };
    if (sua) {
      const r = await chay(() =>
        goiApi(`trainers/${trainer.id}`, { method: 'PATCH', body: { ...chung, ...(hhDoi ? { commission: hh } : {}) } }),
      );
      if (r !== undefined) {
        setXong(hhDoi ? 'Đã lưu. Hoa hồng mới áp dụng từ ngày mai.' : 'Đã lưu.');
        router.refresh();
      }
    } else {
      const r = await chay(() =>
        goiApi<{ id: string }>('trainers', {
          method: 'POST',
          body: {
            phone: v.phone.trim(),
            fullName: v.fullName.trim(),
            ...(v.email.trim() ? { email: v.email.trim() } : {}),
            ...chung,
            ...(rieng ? { commission: hh } : {}),
          },
        }),
      );
      if (r) router.push(`/trainers/${r.id}`);
    }
  }

  return (
    <form onSubmit={luu} className="stack" style={{ gap: 20 }}>
      <Card title="Hồ sơ" desc={sua ? 'Họ tên, số điện thoại, email thuộc tài khoản của HLV — không sửa ở đây.' : undefined}>
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Số điện thoại</span>
              <input className="input tabular" required inputMode="tel" value={v.phone} onChange={dat('phone')} disabled={sua} />
            </label>
            <label className="field">
              <span className="field-label">Họ tên</span>
              <input className="input" required minLength={2} maxLength={120} value={v.fullName} onChange={dat('fullName')} disabled={sua} />
            </label>
            <label className="field">
              <span className="field-label">Email {!sua && <span className="faint">(không bắt buộc)</span>}</span>
              <input className="input" type="email" value={v.email} onChange={dat('email')} disabled={sua} />
            </label>
            <label className="field">
              <span className="field-label">Bậc</span>
              <select className="input" value={v.level} onChange={dat('level')}>
                <option value="">—</option>
                <option value="JUNIOR">Junior</option>
                <option value="SENIOR">Senior</option>
                <option value="MASTER">Master</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Lương cứng / tháng (₫)</span>
              <input className="input tabular" type="number" min={0} step={100000} value={v.baseSalary} onChange={dat('baseSalary')} />
              <span className="field-hint">{vnd(v.baseSalary)} ₫</span>
            </label>
            <label className="field">
              <span className="field-label">Ngày vào làm</span>
              <DatePicker
                value={v.hiredOn}
                onChange={(hiredOn) => {
                  setXong('');
                  setV((s) => ({ ...s, hiredOn }));
                }}
              />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Giới thiệu</span>
            <textarea className="input" rows={3} maxLength={2000} value={v.bio} onChange={dat('bio')}
              placeholder="Chuyên môn, chứng chỉ — hiện cho hội viên khi chọn HLV" />
          </label>
        </div>
      </Card>

      <Card
        title="Hoa hồng"
        desc="Hoa hồng bán tính trên tiền THỰC THU; hoa hồng dạy tính theo buổi đã dạy."
        actions={
          <label className="row-start small" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={rieng} disabled={sua && !!hhGoc} onChange={(e) => { setXong(''); setRieng(e.target.checked); }} />
            Đặt riêng cho HLV này
          </label>
        }
      >
        {!rieng ? (
          <p className="small muted" style={{ margin: 0 }}>Đang theo mức mặc định của phòng tập.</p>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">Hoa hồng bán (%)</span>
                <input className="input tabular" type="number" min={0} max={100} step={0.5} value={hh.salePct}
                  onChange={(e) => datHh('salePct', Math.min(100, so(e.target.value)))} />
              </label>
              <label className="field">
                <span className="field-label">Hoa hồng dạy</span>
                <select className="input" value={hh.teachMode} onChange={(e) => datHh('teachMode', e.target.value as 'FIXED' | 'PCT')}>
                  <option value="FIXED">Cố định mỗi buổi</option>
                  <option value="PCT">% giá trị buổi</option>
                </select>
              </label>
              {hh.teachMode === 'FIXED' ? (
                <label className="field">
                  <span className="field-label">Mỗi buổi (₫)</span>
                  <input className="input tabular" type="number" min={0} step={10000} value={hh.teachFixedAmount}
                    onChange={(e) => datHh('teachFixedAmount', Math.trunc(so(e.target.value)))} />
                </label>
              ) : (
                <label className="field">
                  <span className="field-label">% giá trị buổi</span>
                  <input className="input tabular" type="number" min={0} max={100} step={0.5} value={hh.teachPct}
                    onChange={(e) => datHh('teachPct', Math.min(100, so(e.target.value)))} />
                </label>
              )}
            </div>
            {trainer?.commission && (
              <Alert tone="info" icon={Info}>
                <span>
                  Mức hiện tại có hiệu lực từ {ngayISO(trainer.commission.effectiveFrom)}. Đổi hôm nay thì áp dụng từ ngày mai.
                </span>
              </Alert>
            )}
          </div>
        )}
      </Card>

      <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : sua ? <Save size={16} /> : <UserPlus size={16} />}
          {sua ? 'Lưu thay đổi' : 'Thêm huấn luyện viên'}
        </button>
        {xong && <span className="small text-success">{xong}</span>}
        {loi && <span className="small text-danger" role="alert">{loi}</span>}
      </div>
    </form>
  );
}
