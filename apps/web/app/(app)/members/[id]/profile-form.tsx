'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Save } from 'lucide-react';
import type { MemberDetail, UpdateMemberRequest } from '@pt/contracts';
import { goiApi } from '../../../../lib/client-api';
import { useAction } from '../../../../lib/use-action';
import { DatePicker } from '../../../../components/date-picker';
import { ngayVN } from '../../../../lib/format';

type V = { dob: string; gender: string; source: string; note: string; status: string };

const tu = (m: MemberDetail): V => ({
  dob: m.dob ?? '',
  gender: m.gender ?? '',
  source: m.source ?? '',
  note: m.note ?? '',
  status: m.status,
});

/** Chỉ gửi ô đã đổi; ô xoá trắng gửi `null` (xoá hẳn), không gửi chuỗi rỗng. */
function khac(truoc: V, sau: V): UpdateMemberRequest {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(sau) as (keyof V)[]) {
    if (sau[k] === truoc[k]) continue;
    out[k] = k === 'status' ? sau[k] : sau[k].trim() === '' ? null : sau[k].trim();
  }
  return out as UpdateMemberRequest;
}

export function ProfileForm({ member, readOnly }: { member: MemberDetail; readOnly: boolean }) {
  const router = useRouter();
  const goc = tu(member);
  const [v, setV] = useState<V>(goc);
  const [xong, setXong] = useState(false);
  const { busy, loi, chay } = useAction();
  const doi = khac(goc, v);
  const coDoi = Object.keys(doi).length > 0;
  const dat = (k: keyof V) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setXong(false);
    setV((s) => ({ ...s, [k]: e.target.value }));
  };

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    if (doi.status === 'BANNED' && !confirm('Cấm hội viên này? Họ sẽ không đặt lịch được nữa.')) return;
    const r = await chay(() => goiApi(`members/${member.id}`, { method: 'PATCH', body: doi }));
    if (r !== undefined) {
      setXong(true);
      router.refresh();
    }
  }

  return (
    <form onSubmit={luu} className="stack" style={{ gap: 14 }}>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">Ngày sinh</span>
          <DatePicker
            value={v.dob}
            onChange={(dob) => {
              setXong(false);
              setV((s) => ({ ...s, dob }));
            }}
            max={ngayVN()}
            chonNam
            disabled={readOnly}
          />
        </label>
        <label className="field">
          <span className="field-label">Giới tính</span>
          <select className="input" value={v.gender} onChange={dat('gender')} disabled={readOnly}>
            <option value="">—</option>
            <option value="MALE">Nam</option>
            <option value="FEMALE">Nữ</option>
            <option value="OTHER">Khác</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">Nguồn</span>
          <input className="input" maxLength={40} value={v.source} onChange={dat('source')} disabled={readOnly} />
        </label>
        <label className="field">
          <span className="field-label">Trạng thái</span>
          <select className="input" value={v.status} onChange={dat('status')} disabled={readOnly}>
            <option value="ACTIVE">Đang hoạt động</option>
            <option value="INACTIVE">Ngừng tập</option>
            <option value="BANNED">Bị cấm</option>
          </select>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Ghi chú</span>
        <textarea className="input" rows={3} maxLength={2000} value={v.note} onChange={dat('note')} disabled={readOnly} />
      </label>
      {!readOnly && (
        <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !coDoi}>
            {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />} Lưu hồ sơ
          </button>
          {xong && !coDoi && <span className="small text-success">Đã lưu.</span>}
          {loi && <span className="small text-danger" role="alert">{loi}</span>}
        </div>
      )}
    </form>
  );
}
