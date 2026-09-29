'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse, SessionResponse, TenantOption } from '@pt/contracts';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

/**
 * Đăng nhập HAI BƯỚC.
 *
 * Bước chọn phòng không phải thủ tục thừa: một người có thể là hội viên ở
 * phòng A và huấn luyện viên ở phòng B bằng cùng một số điện thoại. Chỉ sau
 * khi chọn, máy chủ mới ký được token mang tenantId — và tenantId trong token
 * là thứ DUY NHẤT quyết định người đó thấy dữ liệu của phòng nào.
 *
 * Khi chỉ có một phòng, bước 2 tự chạy nên người dùng không thấy gì thêm.
 */
export default function LoginPage() {
  const router = useRouter();
  const [phone, setPhone] = useState('+84901000001');
  const [password, setPassword] = useState('Matkhau@123');
  const [pre, setPre] = useState<LoginResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function chooseTenant(preToken: string, t: TenantOption) {
    const res = await fetch(`${API}/auth/select-tenant`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${preToken}` },
      body: JSON.stringify({ tenantId: t.tenantId }),
    });
    if (!res.ok) throw new Error('Không vào được phòng tập này');
    const s = (await res.json()) as SessionResponse;

    // Token đi thẳng vào cookie httpOnly qua route handler của Next; mã client
    // không giữ lại bản sao nào.
    await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        tenantName: s.tenant.name,
        expiresIn: s.expiresIn,
      }),
    });
    router.replace('/members');
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phone, password }),
      });
      if (!res.ok) throw new Error('Số điện thoại hoặc mật khẩu không đúng');
      const data = (await res.json()) as LoginResponse;
      if (data.tenants.length === 1) {
        await chooseTenant(data.preToken, data.tenants[0]!);
        return;
      }
      setPre(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  if (pre) {
    return (
      <main style={S.wrap}>
        <div style={S.card}>
          <h1 style={S.h1}>Chọn phòng tập</h1>
          <p style={S.sub}>Xin chào {pre.fullName}. Bạn đang có mặt ở nhiều phòng tập.</p>
          {pre.tenants.map((t) => (
            <button
              key={t.tenantId}
              style={S.tenantBtn}
              onClick={() => void chooseTenant(pre.preToken, t)}
            >
              <strong>{t.name}</strong>
              <span style={S.roles}>{t.roles.join(' · ')}</span>
            </button>
          ))}
          {error && <p style={S.err}>{error}</p>}
        </div>
      </main>
    );
  }

  return (
    <main style={S.wrap}>
      <form style={S.card} onSubmit={onSubmit}>
        <h1 style={S.h1}>Đăng nhập</h1>
        <p style={S.sub}>Hệ thống quản lý hội viên PT</p>
        <label style={S.label}>
          Số điện thoại
          <input style={S.input} value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label style={S.label}>
          Mật khẩu
          <input
            style={S.input}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p style={S.err}>{error}</p>}
        <button style={S.primary} disabled={busy} type="submit">
          {busy ? 'Đang xử lý…' : 'Đăng nhập'}
        </button>
      </form>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  wrap: { minHeight: '100dvh', display: 'grid', placeItems: 'center', background: '#0f1115' },
  card: {
    width: 'min(400px, 92vw)', background: '#171a21', border: '1px solid #262b36',
    borderRadius: 14, padding: 28, display: 'flex', flexDirection: 'column', gap: 14,
  },
  h1: { margin: 0, fontSize: 22, color: '#f2f4f8' },
  sub: { margin: 0, fontSize: 13, color: '#8b93a7' },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#b6bdcd' },
  input: {
    padding: '10px 12px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#0f1115', color: '#f2f4f8', fontSize: 14,
  },
  primary: {
    marginTop: 6, padding: '11px 14px', borderRadius: 8, border: 'none',
    background: '#3b82f6', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  tenantBtn: {
    display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start',
    padding: '12px 14px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#0f1115', color: '#f2f4f8', cursor: 'pointer', textAlign: 'left',
  },
  roles: { fontSize: 12, color: '#8b93a7' },
  err: { margin: 0, fontSize: 13, color: '#f87171' },
};
