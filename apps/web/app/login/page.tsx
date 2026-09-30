'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  ChevronRight,
  CircleAlert,
  Dumbbell,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Lock,
  Phone,
  QrCode,
  ShieldCheck,
  ShieldHalf,
  Smartphone,
  Wallet,
  Zap,
} from 'lucide-react';
import type { LoginResponse, PlatformSessionResponse, SessionResponse, TenantOption } from '@pt/contracts';
import { TEN_VAI_TRO } from '../../lib/format';
import { duongDanTiepTheo } from '../../lib/duong-dan';
import { ChangePassword } from './change-password';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';

type Cach = 'MAT_KHAU' | 'OTP' | 'NHANH';

// useSearchParams cần ranh giới Suspense, không thì cả trang bị ép render phía
// client lúc build.
export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

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
 *
 * `?next=` (middleware gắn khi chặn một trang lúc chưa đăng nhập): xong thì
 * quay lại đúng trang đó — ca chính là hội viên quét mã QR điểm danh.
 */
function Login() {
  const router = useRouter();
  const tiep = duongDanTiepTheo(useSearchParams().get('next'));
  const diemDanh = tiep?.startsWith('/me/checkin') ?? false;
  const [cach, setCach] = useState<Cach>('OTP');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [hienMatKhau, setHienMatKhau] = useState(false);
  const [code, setCode] = useState('');
  const [daGuiMa, setDaGuiMa] = useState(false);
  const [maDev, setMaDev] = useState<string | null>(null);
  const [pre, setPre] = useState<LoginResponse | null>(null);
  const [doiMk, setDoiMk] = useState<LoginResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * Tab "Vào nhanh" (chỉ số điện thoại) chỉ hiện khi API nói cửa đang mở —
   * máy lập trình hoặc staging có DEV_LOGIN_BYPASS=1. Hỏi lúc chạy vì cùng một
   * image chạy cả staging lẫn thật. Cửa thật vẫn là API: tab chỉ là lối vào.
   */
  const [coVaoNhanh, setCoVaoNhanh] = useState(false);
  useEffect(() => {
    fetch(API + '/auth/dev-login')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean } | null) => setCoVaoNhanh(d?.enabled === true))
      .catch(() => {});
  }, []);

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

  async function chonPhong(login: LoginResponse, t: TenantOption) {
    const s = (await post('/auth/select-tenant', { tenantId: t.tenantId }, {
      authorization: `Bearer ${login.preToken}`,
    })) as SessionResponse;

    // Token đi thẳng vào cookie httpOnly qua route handler của Next; mã client
    // không giữ lại bản sao nào.
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        tenantName: s.tenant.name,
        fullName: login.fullName,
        roles: s.tenant.roles,
        expiresIn: s.expiresIn,
      }),
    });
    if (!res.ok) throw new Error('Không lưu được phiên đăng nhập');
    // Có trang đang chờ (vd. điểm danh) thì về đó; không thì về '/' để trang
    // gốc điều hướng theo vai trò: hội viên vào /me, nhân viên vào màn quản lý.
    // Phiên phòng tập không mở được /platform nên bỏ qua `next` loại đó.
    router.replace(tiep && !tiep.startsWith('/platform') ? tiep : '/');
    router.refresh();
  }

  /**
   * Phiên QUẢN TRỊ NỀN TẢNG: token không mang tenantId nào, chỉ vào được
   * /platform. API chỉ cấp khi đăng nhập bằng MẬT KHẨU — ai cầm được điện thoại
   * của quản trị viên (nhận OTP) không vì thế mà nhìn được mọi phòng tập.
   */
  async function chonNenTang(login: LoginResponse) {
    const s = (await post('/auth/select-platform', {}, {
      authorization: `Bearer ${login.preToken}`,
    })) as PlatformSessionResponse;
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        tenantName: 'Quản trị nền tảng',
        fullName: s.fullName,
        roles: [],
        expiresIn: s.expiresIn,
        platformLevel: s.level,
      }),
    });
    if (!res.ok) throw new Error('Không lưu được phiên đăng nhập');
    router.replace(tiep?.startsWith('/platform') ? tiep : '/platform');
    router.refresh();
  }

  async function tiepTuc(data: LoginResponse) {
    if (data.mustChangePassword) {
      setPassword('');
      return setDoiMk(data);
    }
    setDoiMk(null);
    if (data.tenants.length === 1 && !data.platform) return chonPhong(data, data.tenants[0]!);
    if (data.tenants.length === 0 && data.platform) return chonNenTang(data);
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

  function doiCach(v: Cach) {
    setCach(v);
    setDaGuiMa(false);
    setMaDev(null);
    setCode('');
    setError('');
  }

  const loi = error && (
    <div className="alert" data-tone="danger" role="alert">
      <CircleAlert size={17} />
      <div className="alert-body">{error}</div>
    </div>
  );

  return (
    <div className="auth">
      <aside className="auth-aside">
        <div className="auth-brand">
          <span className="brand-mark">
            <Dumbbell size={18} strokeWidth={2.4} />
          </span>
          PT Studio
        </div>

        <div>
          <h1 className="auth-headline">Vận hành phòng tập cá nhân gọn trong một màn hình.</h1>
          <p className="auth-lead">
            Lịch tập, điểm danh, gói buổi và công nợ — minh bạch cho cả phòng tập lẫn hội viên.
          </p>
          <ul className="auth-points">
            <li>
              <span className="pt-icon">
                <CalendarClock size={16} />
              </span>
              <span>
                <strong>Lịch tập theo tuần</strong>
                Biết ngay ai tập với ai, buổi nào còn chờ.
              </span>
            </li>
            <li>
              <span className="pt-icon">
                <QrCode size={16} />
              </span>
              <span>
                <strong>Điểm danh bằng mã QR</strong>
                Mã đổi mỗi phút, chụp màn hình gửi người khác là vô dụng.
              </span>
            </li>
            <li>
              <span className="pt-icon">
                <Wallet size={16} />
              </span>
              <span>
                <strong>Sổ buổi và công nợ rõ ràng</strong>
                Mỗi buổi bị trừ đều có lý do, mỗi đợt trả góp đều có hạn.
              </span>
            </li>
          </ul>
        </div>

        <p className="auth-foot">© {new Date().getFullYear()} PT Studio</p>
      </aside>

      <main className="auth-main">
        {doiMk ? (
          <ChangePassword login={doiMk} onDone={tiepTuc} onBack={() => setDoiMk(null)} />
        ) : pre ? (
          // --- màn chọn phòng -------------------------------------------------
          <div className="auth-card">
            <button type="button" className="back-link" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer' }} onClick={() => setPre(null)}>
              <ArrowLeft size={15} /> Quay lại
            </button>
            <div>
              <h2 className="auth-title">{pre.platform ? 'Chọn nơi làm việc' : 'Chọn phòng tập'}</h2>
              <p className="page-sub">
                Xin chào <strong>{pre.fullName}</strong>
                {pre.platform
                  ? ', bạn có quyền quản trị nền tảng.'
                  : `, bạn có mặt ở ${pre.tenants.length} phòng tập.`}
              </p>
            </div>
            <div className="stack" style={{ gap: 10 }}>
              {pre.tenants.map((t) => (
                <button
                  key={t.tenantId}
                  type="button"
                  className="tenant-option"
                  disabled={busy}
                  onClick={() => void chay(() => chonPhong(pre, t))}
                >
                  <span className="icon-tile">
                    <Building2 size={19} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="cell-main" style={{ display: 'block' }}>
                      {t.name}
                    </span>
                    <span className="cell-sub">{t.roles.map((r) => TEN_VAI_TRO[r] ?? r).join(' · ')}</span>
                  </span>
                  {busy ? <LoaderCircle size={18} className="spin faint" /> : <ChevronRight size={18} className="faint" />}
                </button>
              ))}
              {pre.platform && (
                <button
                  type="button"
                  className="tenant-option"
                  disabled={busy}
                  onClick={() => void chay(() => chonNenTang(pre))}
                >
                  <span className="icon-tile" data-tone="neutral">
                    <ShieldHalf size={19} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className="cell-main" style={{ display: 'block' }}>
                      Quản trị nền tảng
                    </span>
                    <span className="cell-sub">Mọi phòng tập · thu tiền gói · cấp {pre.platform.level}</span>
                  </span>
                  {busy ? <LoaderCircle size={18} className="spin faint" /> : <ChevronRight size={18} className="faint" />}
                </button>
              )}
            </div>
            {loi}
          </div>
        ) : (
          // --- màn đăng nhập --------------------------------------------------
          <form
            className="auth-card"
            onSubmit={(e) => {
              e.preventDefault();
              void chay(async () => {
                if (cach === 'MAT_KHAU') {
                  return tiepTuc((await post('/auth/login', { phone, password })) as LoginResponse);
                }
                if (cach === 'NHANH') {
                  return tiepTuc((await post('/auth/dev-login', { phone })) as LoginResponse);
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
            <div className="auth-mobile-brand">
              <span className="brand-mark">
                <Dumbbell size={17} strokeWidth={2.4} />
              </span>
              PT Studio
            </div>

            <div>
              <h2 className="auth-title">Đăng nhập</h2>
              <p className="page-sub">
                {cach === 'OTP'
                  ? 'Hội viên đăng nhập bằng mã gửi về số điện thoại.'
                  : cach === 'NHANH'
                    ? 'Môi trường dev: chỉ cần số điện thoại, không mật khẩu, không mã.'
                    : 'Nhân viên đăng nhập bằng mật khẩu được cấp.'}
              </p>
            </div>

            {/* Hội viên vừa quét mã QR trên điện thoại chưa đăng nhập: nói rõ vì
                sao lại ở màn này và điều gì xảy ra sau đó. */}
            {diemDanh && (
              <div className="alert" data-tone="info" role="status">
                <QrCode size={17} />
                <div className="alert-body">
                  Đăng nhập để điểm danh buổi tập — xong sẽ tự quay lại trang điểm danh. Lần sau không phải đăng
                  nhập lại trên máy này.
                </div>
              </div>
            )}

            <div className="segmented segmented-block" role="tablist">
              {(
                [
                  ['OTP', 'Mã xác thực', Smartphone],
                  ['MAT_KHAU', 'Mật khẩu', KeyRound],
                  ...(coVaoNhanh ?([['NHANH', 'Vào nhanh', Zap]] as const) : []),
                ] as const
              ).map(([v, label, Icon]) => (
                <button key={v} type="button" role="tab" aria-selected={cach === v} onClick={() => doiCach(v)}>
                  <Icon size={15} />
                  {label}
                </button>
              ))}
            </div>

            <label className="field">
              <span className="field-label">Số điện thoại</span>
              <span className="input-wrap">
                <Phone size={17} />
                <input
                  className="input"
                  value={phone}
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="0901 000 001"
                  required
                  readOnly={cach === 'OTP' && daGuiMa}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setDaGuiMa(false);
                  }}
                />
              </span>
            </label>

            {cach === 'NHANH' && (
              <span className="dev-hint">
                <CircleAlert size={13} /> Chỉ có ở máy lập trình / <strong>staging</strong> — không bao giờ ở môi trường thật.
              </span>
            )}

            {cach === 'MAT_KHAU' && (
              <label className="field">
                <span className="field-label">Mật khẩu</span>
                <span className="input-wrap">
                  <Lock size={17} />
                  <input
                    className="input"
                    type={hienMatKhau ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={password}
                    required
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className="input-action"
                    aria-label={hienMatKhau ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                    onClick={() => setHienMatKhau((v) => !v)}
                  >
                    {hienMatKhau ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </span>
              </label>
            )}

            {cach === 'OTP' && daGuiMa && (
              <label className="field">
                <span className="field-label">Mã xác thực</span>
                <input
                  className="input input-otp"
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="••••••"
                  autoFocus
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                />
                <span className="field-hint">Nhập 6 chữ số vừa gửi tới {phone}.</span>
                {/* Chỉ có ở môi trường dev: API trả kèm mã để thử mà không cần
                    kênh gửi thật. Production không bao giờ có trường này. */}
                {maDev && (
                  <span className="dev-hint">
                    <CircleAlert size={13} /> Mã ở môi trường dev: <strong>{maDev}</strong>
                  </span>
                )}
              </label>
            )}

            {loi}

            <button
              className="btn btn-primary btn-lg btn-block"
              disabled={busy || (cach === 'OTP' && daGuiMa && code.length !== 6)}
              type="submit"
            >
              {busy && <LoaderCircle size={18} className="spin" />}
              {busy
                ? 'Đang xử lý…'
                : cach === 'MAT_KHAU'
                  ? 'Đăng nhập'
                  : cach === 'NHANH'
                    ? 'Vào ngay'
                  : daGuiMa
                    ? 'Xác nhận'
                    : 'Gửi mã xác thực'}
            </button>

            {cach === 'OTP' && daGuiMa && (
              <button
                type="button"
                className="btn btn-ghost btn-block"
                onClick={() => {
                  setDaGuiMa(false);
                  setCode('');
                  setMaDev(null);
                }}
              >
                Đổi số điện thoại
              </button>
            )}

            <p className="field-hint" style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center' }}>
              <ShieldCheck size={14} /> Phiên đăng nhập được lưu an toàn trên thiết bị này.
            </p>
          </form>
        )}
      </main>
    </div>
  );
}
