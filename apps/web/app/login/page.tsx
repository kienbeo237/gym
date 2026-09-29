'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { LoginResponse, SessionResponse, TenantOption } from '@pt/contracts';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

type Cach = 'MAT_KHAU' | 'OTP';

/**
 * Đăng nhập HAI BƯỚC, hai đường vào.
 *
 * Bước chọn phòng không phải thủ tục thừa: một người có thể là hội viên ở
 * phòng A và huấn luyện viên ở phòng B bằng cùng một số điện thoại. Chỉ sau
 * khi chọn, máy chủ mới ký được token mang tenantId — và tenantId trong token
 * là thứ DUY NHẤT quyết định người đó thấy dữ liệu của phòng nào.
 * Khi chỉ có một phòng, bước 2 tự chạy nên người dùng không thấy gì thêm.
 *
 * Mặc định là OTP vì phần lớn người đăng nhập là HỘI VIÊN, và họ không có mật
 * khẩu để nhớ — tài khoản do lễ tân tạo. Mật khẩu là đường của nhân viên.
 */
export default function LoginPage() {
  const router = useRouter();
  const [cach, setCach] = useState<Cach>('OTP');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [daGuiMa, setDaGuiMa] = useState(false);
  const [maDev, setMaDev] = useState<string | null>(null);
  const [pre, setPre] = useState<LoginResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message ?? 'Đã có lỗi xảy ra');
    return data;
  }

  async function chonPhong(preToken: string, t: TenantOption) {
    const s = (await post('/auth/select-tenant', { tenantId: t.tenantId }, {
      authorization: `Bearer ${preToken}`,
    })) as SessionResponse;

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

  async function tiepTuc(data: LoginResponse) {
    if (data.tenants.length === 1) return chonPhong(data.preToken, data.tenants[0]!);
    setPre(data);
  }

  async function chay(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  // --- màn chọn phòng -------------------------------------------------------
  if (pre) {
    return (
      <main style={S.wrap}>
        <div style={S.card}>
          <h1 style={S.h1}>Chọn phòng tập</h1>
          <p style={S.sub}>Xin chào {pre.fullName}. Bạn đang có mặt ở nhiều phòng tập.</p>
          {pre.tenants.map((t) => (
            <button key={t.tenantId} style={S.tenantBtn} onClick={() => void chay(() => chonPhong(pre.preToken, t))}>
              <strong>{t.name}</strong>
              <span style={S.roles}>{t.roles.join(' · ')}</span>
            </button>
          ))}
          {error && <p style={S.err}>{error}</p>}
        </div>
      </main>
    );
  }

  // --- màn đăng nhập --------------------------------------------------------
  return (
    <main style={S.wrap}>
      <form
        style={S.card}
        onSubmit={(e) => {
          e.preventDefault();
          void chay(async () => {
            if (cach === 'MAT_KHAU') {
              return tiepTuc((await post('/auth/login', { phone, password })) as LoginResponse);
            }
            if (!daGuiMa) {
              const r = (await post('/auth/otp/request', { phone })) as { devCode?: string };
              setDaGuiMa(true);
              setMaDev(r.devCode ?? null);
              return;
            }
            return tiepTuc((await post('/auth/otp/verify', { phone, code })) as LoginResponse);
          });
        }}
      >
        <h1 style={S.h1}>Đăng nhập</h1>
        <p style={S.sub}>Hệ thống quản lý hội viên PT</p>

        <div style={S.tabs}>
          {(
            [
              ['OTP', 'Mã xác thực'],
              ['MAT_KHAU', 'Mật khẩu'],
            ] as [Cach, string][]
          ).map(([v, label]) => (
            <button
              key={v}
              type="button"
              style={{ ...S.tab, ...(cach === v ? S.tabOn : {}) }}
              onClick={() => {
                setCach(v);
                setDaGuiMa(false);
                setMaDev(null);
                setError('');
              }}
            >
              {label}
            </button>
          ))}
        </div>

        <label style={S.label}>
          Số điện thoại
          <input
            style={S.input}
            value={phone}
            inputMode="tel"
            placeholder="0901 000 001"
            onChange={(e) => {
              setPhone(e.target.value);
              setDaGuiMa(false);
            }}
          />
        </label>

        {cach === 'MAT_KHAU' && (
          <label style={S.label}>
            Mật khẩu
            <input style={S.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}

        {cach === 'OTP' && daGuiMa && (
          <label style={S.label}>
            Mã xác thực (6 chữ số)
            <input
              style={{ ...S.input, letterSpacing: 6, fontSize: 18 }}
              value={code}
              inputMode="numeric"
              maxLength={6}
              autoFocus
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            {/* Chỉ có ở môi trường dev: API trả kèm mã để thử mà không cần
                kênh gửi thật. Production không bao giờ có trường này. */}
            {maDev && <span style={S.devHint}>Mã ở môi trường dev: {maDev}</span>}
          </label>
        )}

        {error && <p style={S.err}>{error}</p>}

        <button style={S.primary} disabled={busy} type="submit">
          {busy
            ? 'Đang xử lý…'
            : cach === 'MAT_KHAU'
              ? 'Đăng nhập'
              : daGuiMa
                ? 'Xác nhận'
                : 'Gửi mã xác thực'}
        </button>

        {cach === 'OTP' && daGuiMa && (
          <button
            type="button"
            style={S.linkBtn}
            onClick={() => {
              setDaGuiMa(false);
              setCode('');
              setMaDev(null);
            }}
          >
            Đổi số điện thoại
          </button>
        )}
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
  tabs: { display: 'flex', gap: 4, padding: 4, background: '#0f1115', borderRadius: 9 },
  tab: {
    flex: 1, padding: '8px 10px', borderRadius: 6, border: 'none', cursor: 'pointer',
    background: 'transparent', color: '#8b93a7', fontSize: 13,
  },
  tabOn: { background: '#262b36', color: '#f2f4f8', fontWeight: 600 },
  label: { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#b6bdcd' },
  input: {
    padding: '10px 12px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#0f1115', color: '#f2f4f8', fontSize: 14,
  },
  devHint: { fontSize: 11, color: '#fbbf24' },
  primary: {
    marginTop: 6, padding: '11px 14px', borderRadius: 8, border: 'none',
    background: '#3b82f6', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  linkBtn: {
    background: 'none', border: 'none', color: '#8b93a7', fontSize: 13, cursor: 'pointer',
  },
  tenantBtn: {
    display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start',
    padding: '12px 14px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#0f1115', color: '#f2f4f8', cursor: 'pointer', textAlign: 'left',
  },
  roles: { fontSize: 12, color: '#8b93a7' },
  err: { margin: 0, fontSize: 13, color: '#f87171' },
};
