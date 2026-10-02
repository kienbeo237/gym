'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, UserPlus } from 'lucide-react';
import { Card, PageHeader } from '../../../../components/ui';
import { goiApi } from '../../../../lib/client-api';
import { useAction } from '../../../../lib/use-action';
import { DatePicker } from '../../../../components/date-picker';
import { ngayVN } from '../../../../lib/format';

/**
 * Thêm hội viên. Số điện thoại là định danh TOÀN HỆ THỐNG: người đã có tài
 * khoản ở phòng khác thì API gắn hồ sơ mới vào đúng người đó (họ tên giữ
 * nguyên theo định danh), không tạo trùng.
 */
export default function NewMemberPage() {
  const router = useRouter();
  const [v, setV] = useState({ phone: '', fullName: '', email: '', dob: '', gender: '', source: '', note: '' });
  const { busy, loi, chay } = useAction();
  const homNay = ngayVN();
  const dat = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setV((s) => ({ ...s, [k]: e.target.value }));

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    const body = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, x.trim()]).filter(([, x]) => x !== ''));
    const r = await chay(() => goiApi<{ id: string }>('members', { method: 'POST', body }));
    if (r) router.push(`/members/${r.id}`);
  }

  return (
    <>
      <PageHeader back={{ href: '/members', label: 'Hội viên' }} title="Thêm hội viên" />
      <form onSubmit={luu} className="stack" style={{ gap: 20, maxWidth: 760 }}>
        <Card title="Thông tin liên hệ" desc="Số điện thoại dùng để đăng nhập ứng dụng hội viên và nhận tin Zalo/SMS.">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Số điện thoại</span>
              <input className="input tabular" required inputMode="tel" value={v.phone} onChange={dat('phone')} placeholder="0901234567" />
            </label>
            <label className="field">
              <span className="field-label">Họ tên</span>
              <input className="input" required minLength={2} maxLength={120} value={v.fullName} onChange={dat('fullName')} />
              <span className="field-hint">Người đã có tài khoản thì giữ tên theo tài khoản.</span>
            </label>
            <label className="field">
              <span className="field-label">Email <span className="faint">(không bắt buộc)</span></span>
              <input className="input" type="email" value={v.email} onChange={dat('email')} />
            </label>
          </div>
        </Card>
        <Card title="Hồ sơ tại phòng">
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Ngày sinh</span>
              <DatePicker value={v.dob} onChange={(dob) => setV((s) => ({ ...s, dob }))} max={homNay} chonNam />
            </label>
            <label className="field">
              <span className="field-label">Giới tính</span>
              <select className="input" value={v.gender} onChange={dat('gender')}>
                <option value="">—</option>
                <option value="MALE">Nam</option>
                <option value="FEMALE">Nữ</option>
                <option value="OTHER">Khác</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Nguồn</span>
              <input className="input" maxLength={40} value={v.source} onChange={dat('source')} placeholder="VD: Facebook, giới thiệu" />
            </label>
          </div>
          <label className="field mt-16">
            <span className="field-label">Ghi chú</span>
            <textarea className="input" rows={3} maxLength={2000} value={v.note} onChange={dat('note')}
              placeholder="Mục tiêu tập, chấn thương cần lưu ý…" />
          </label>
        </Card>
        {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
        <div>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <UserPlus size={16} />} Thêm hội viên
          </button>
        </div>
      </form>
    </>
  );
}
