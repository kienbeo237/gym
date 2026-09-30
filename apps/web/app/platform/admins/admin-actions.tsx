'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, TriangleAlert, UserMinus, UserPlus } from 'lucide-react';
import type { AddPlatformAdminResult } from '@pt/contracts';
import { CopyButton } from '../../../components/copy-button';
import { goiApi, thongBaoLoi } from '../../../lib/client-api';

const CAP = [
  { key: 'SUPPORT', label: 'Hỗ trợ (chỉ xem)' },
  { key: 'OPS', label: 'Vận hành' },
  { key: 'SUPER', label: 'Toàn quyền' },
];

/**
 * Cấp quyền cho một số điện thoại. Số đã có tài khoản (vd. chủ phòng) thì
 * giữ nguyên mật khẩu; số mới thì API sinh mật khẩu tạm — hiện ĐÚNG MỘT LẦN
 * ở đây, người nhận phải đổi ở lần đăng nhập đầu.
 */
export function AddAdmin() {
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [fullName, setFullName] = useState('');
  const [level, setLevel] = useState('SUPPORT');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [kq, setKq] = useState<{ phone: string; tempPassword: string | null } | null>(null);

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    try {
      const r = await goiApi<AddPlatformAdminResult>('platform/admins', {
        method: 'POST',
        body: { phone: phone.trim(), fullName: fullName.trim(), level },
      });
      setKq({ phone: phone.trim(), tempPassword: r.tempPassword });
      setPhone('');
      setFullName('');
      setLevel('SUPPORT');
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      {kq && (
        <div className="panel stack" style={{ gap: 10 }} role="status">
          <strong>Đã cấp quyền cho {kq.phone}</strong>
          {kq.tempPassword ? (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Mật khẩu tạm dưới đây <strong>chỉ hiện một lần</strong>. Gửi riêng cho người nhận (gọi điện hoặc nhắn trực
                tiếp); họ sẽ phải đặt mật khẩu mới ở lần đăng nhập đầu.
              </p>
              <div className="row-start" style={{ gap: 10, flexWrap: 'wrap' }}>
                <code className="mono" style={{ fontSize: 17, letterSpacing: 1 }}>
                  {kq.tempPassword}
                </code>
                <CopyButton text={kq.tempPassword} label="Chép mật khẩu" />
              </div>
            </>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Số này đã có tài khoản — người đó đăng nhập bằng mật khẩu đang dùng, rồi chọn &ldquo;Quản trị nền tảng&rdquo;.
            </p>
          )}
          <div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setKq(null)}>
              Đã ghi lại, ẩn đi
            </button>
          </div>
        </div>
      )}

      <form id="them-qtv" className="form-grid" onSubmit={gui}>
        <label className="field">
          <span className="field-label">Số điện thoại</span>
          <input className="input" inputMode="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09xxxxxxxx" />
        </label>
        <label className="field">
          <span className="field-label">Họ tên</span>
          <input className="input" required minLength={2} maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          <span className="field-hint">Số đã có tài khoản thì giữ tên cũ.</span>
        </label>
        <label className="field">
          <span className="field-label">Cấp</span>
          <select className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            {CAP.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="field-hint">Bắt đầu từ cấp thấp nhất đủ dùng.</span>
        </label>
      </form>
      <div>
        <button className="btn btn-primary" type="submit" form="them-qtv" disabled={busy}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <UserPlus size={15} />} Cấp quyền
        </button>
      </div>
      {loi && (
        <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
          {loi}
        </p>
      )}
    </div>
  );
}

/** Đổi cấp / thu quyền một người khác (API chặn tự sửa mình và bỏ người Toàn quyền cuối). */
export function AdminRowActions({ id, name, level }: { id: string; name: string; level: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function lam(fn: () => Promise<unknown>) {
    setBusy(true);
    setLoi('');
    try {
      await fn();
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
    } finally {
      setBusy(false);
    }
  }

  function doiCap(moi: string) {
    if (moi === level) return;
    const ten = CAP.find((c) => c.key === moi)?.label ?? moi;
    if (!window.confirm(`Đổi ${name} sang cấp "${ten}"? API áp cấp mới ngay từ thao tác kế tiếp của họ.`)) return;
    void lam(() => goiApi(`platform/admins/${id}`, { method: 'PATCH', body: { level: moi } }));
  }

  function thu() {
    if (!window.confirm(`Thu quyền quản trị nền tảng của ${name}? Họ bị đăng xuất khỏi trang nền tảng ngay.`)) return;
    void lam(() => goiApi(`platform/admins/${id}`, { method: 'DELETE' }));
  }

  return (
    <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
      <div className="row-start" style={{ gap: 6, justifyContent: 'flex-end' }}>
        <label>
          <span className="sr-only">Cấp của {name}</span>
          <select className="input" style={{ height: 34, width: "auto" }} value={level} disabled={busy} onChange={(e) => doiCap(e.target.value)}>
            {CAP.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-ghost btn-sm text-danger" disabled={busy} onClick={thu} title="Thu quyền">
          {busy ? <LoaderCircle size={14} className="spin" /> : <UserMinus size={14} />}
          <span className="hide-sm">Thu quyền</span>
        </button>
      </div>
      {loi && (
        <span className="small text-danger row-start" style={{ gap: 4 }} role="alert">
          <TriangleAlert size={12} /> {loi}
        </span>
      )}
    </div>
  );
}
