'use client';

import { useState } from 'react';
import { ArrowLeft, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, Lock } from 'lucide-react';
import type { LoginResponse } from '@pt/contracts';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

/**
 * Nhắc NGAY khi gõ, cùng luật với `NewPassword` ở @pt/contracts. Chỉ để nhắc —
 * API mới là nơi kiểm thật (mã client không import được schema zod từ gói
 * CommonJS đó, và kéo cả gói xuống trình duyệt cho một phép kiểm là thừa).
 */
function loiMatKhau(mk: string): string {
  if (mk.length < 8) return 'Mật khẩu cần ít nhất 8 ký tự';
  if (mk.length > 72) return 'Mật khẩu tối đa 72 ký tự';
  if (!/[A-Za-z]/.test(mk)) return 'Mật khẩu cần có chữ cái';
  if (!/[0-9]/.test(mk)) return 'Mật khẩu cần có chữ số';
  return '';
}

/**
 * Đăng nhập bằng MẬT KHẨU TẠM: bắt đặt mật khẩu riêng trước khi vào đâu cả.
 *
 * preToken của bước này (stage CHANGE_PASSWORD) chỉ mở được /auth/change-password.
 * Đổi xong API trả kết quả bước 1 như đăng nhập thường; trang cha đi tiếp bước
 * chọn phòng bằng chính kết quả đó — không phải gõ lại mật khẩu mới.
 */
export function ChangePassword({
  login,
  onDone,
  onBack,
}: {
  login: LoginResponse;
  onDone: (next: LoginResponse) => Promise<void>;
  onBack: () => void;
}) {
  const [mk, setMk] = useState('');
  const [mk2, setMk2] = useState('');
  const [hien, setHien] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loiMk = mk ? loiMatKhau(mk) : '';
  const hopLe = Boolean(mk) && !loiMk;
  const lech = mk2 && mk !== mk2;

  async function gui() {
    setError('');
    setBusy(true);
    try {
      const res = await fetch(API + '/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${login.preToken}` },
        body: JSON.stringify({ newPassword: mk }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) throw new Error('Phiên đổi mật khẩu đã hết hạn (10 phút). Đăng nhập lại bằng mật khẩu tạm.');
      if (!res.ok) throw new Error(data.message ?? 'Không đổi được mật khẩu');
      await onDone(data as LoginResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="auth-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (hopLe && !lech) void gui();
      }}
    >
      <button type="button" className="back-link" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer' }} onClick={onBack}>
        <ArrowLeft size={15} /> Quay lại
      </button>
      <div>
        <span className="icon-tile" data-tone="warning" style={{ marginBottom: 12 }}>
          <KeyRound size={19} />
        </span>
        <h2 className="auth-title">Đặt mật khẩu mới</h2>
        <p className="page-sub">
          Xin chào <strong>{login.fullName}</strong>, bạn đang dùng mật khẩu tạm được cấp. Đặt mật khẩu của riêng bạn để tiếp
          tục — mật khẩu tạm sẽ hết hiệu lực ngay.
        </p>
      </div>

      <label className="field">
        <span className="field-label">Mật khẩu mới</span>
        <span className="input-wrap">
          <Lock size={17} />
          <input
            className="input"
            type={hien ? 'text' : 'password'}
            autoComplete="new-password"
            value={mk}
            required
            autoFocus
            onChange={(e) => setMk(e.target.value)}
          />
          <button type="button" className="input-action" aria-label={hien ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'} onClick={() => setHien((v) => !v)}>
            {hien ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </span>
        <span className={loiMk ? 'field-hint text-danger' : 'field-hint'}>{loiMk || 'Ít nhất 8 ký tự, có cả chữ và số.'}</span>
      </label>

      <label className="field">
        <span className="field-label">Nhập lại mật khẩu mới</span>
        <span className="input-wrap">
          <Lock size={17} />
          <input
            className="input"
            type={hien ? 'text' : 'password'}
            autoComplete="new-password"
            value={mk2}
            required
            onChange={(e) => setMk2(e.target.value)}
          />
        </span>
        {lech && <span className="field-hint text-danger">Hai mật khẩu chưa khớp.</span>}
      </label>

      {error && (
        <div className="alert" data-tone="danger" role="alert">
          <CircleAlert size={17} />
          <div className="alert-body">{error}</div>
        </div>
      )}

      <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={busy || !hopLe || !mk2 || Boolean(lech)}>
        {busy && <LoaderCircle size={18} className="spin" />}
        {busy ? 'Đang lưu…' : 'Lưu mật khẩu và tiếp tục'}
      </button>
    </form>
  );
}
