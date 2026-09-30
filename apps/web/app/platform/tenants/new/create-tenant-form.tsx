'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CircleCheck, KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { CreateTenantResult, PlanInfo } from '@pt/contracts';
import { Alert, Card } from '../../../../components/ui';
import { CopyButton } from '../../../../components/copy-button';
import { goiApi, thongBaoLoi } from '../../../../lib/client-api';
import { vnd } from '../../../../lib/format';

/** "Phòng Tập Alpha Quận 1" -> "phong-tap-alpha-quan-1". */
function taoTenMien(ten: string): string {
  return ten
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

export function CreateTenantForm({ plans }: { plans: PlanInfo[] }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [tuSuaSlug, setTuSuaSlug] = useState(false);
  const [planCode, setPlanCode] = useState(plans.find((p) => p.code === 'BASIC')?.code ?? plans[0]?.code ?? '');
  const [trialDays, setTrialDays] = useState(14);
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [kq, setKq] = useState<(CreateTenantResult & { phone: string }) | null>(null);

  const goi = plans.find((p) => p.code === planCode);

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    try {
      const r = await goiApi<CreateTenantResult>('platform/tenants', {
        method: 'POST',
        body: { name, slug, planCode, trialDays, ownerName, ownerPhone },
      });
      setKq({ ...r, phone: ownerPhone });
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  if (kq) {
    return (
      <Card title="Đã tạo phòng tập">
        <div className="stack" style={{ gap: 14 }}>
          <Alert tone="success" icon={CircleCheck}>
            <span>
              Phòng <strong>{name}</strong> đã sẵn sàng.{' '}
              {trialDays > 0
                ? `Dùng thử ${trialDays} ngày; hoá đơn kỳ đầu sẽ tự phát hành 7 ngày trước khi hết hạn.`
                : 'Không dùng thử — hoá đơn kỳ đầu đã được phát hành, xem ở hàng đối soát.'}
            </span>
          </Alert>
          {kq.tempPassword ? (
            <>
              <p className="small muted" style={{ margin: 0 }}>
                Mật khẩu tạm của chủ phòng — <strong>chỉ hiện MỘT lần này</strong>. Gửi cho chủ phòng qua kênh riêng
                (gọi điện, Zalo cá nhân) cùng số điện thoại đăng nhập {kq.phone}.
              </p>
              <div className="ref-box">
                <span className="row-start" style={{ gap: 10 }}>
                  <KeyRound size={18} className="muted" />
                  <span className="mono">{kq.tempPassword}</span>
                </span>
                <CopyButton text={kq.tempPassword} label="Chép mật khẩu" />
              </div>
            </>
          ) : (
            <Alert tone="info" icon={KeyRound}>
              <span>
                Số {kq.phone} đã có tài khoản — chủ phòng đăng nhập bằng mật khẩu hiện có (hoặc mã OTP) rồi chọn phòng mới.
              </span>
            </Alert>
          )}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <Link href={`/platform/tenants/${kq.tenantId}`} className="btn btn-primary">
              Mở phòng vừa tạo <ArrowRight size={16} />
            </Link>
            <Link href="/platform/tenants" className="btn btn-ghost">
              Về danh sách
            </Link>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <form onSubmit={gui} className="stack" style={{ gap: 16, maxWidth: 760 }}>
      <Card title="Phòng tập">
        <div className="stack" style={{ gap: 12 }}>
          <label className="field">
            <span className="field-label">Tên phòng tập</span>
            <input
              className="input"
              value={name}
              required
              minLength={2}
              placeholder="VD: Phòng tập Alpha Quận 1"
              onChange={(e) => {
                setName(e.target.value);
                if (!tuSuaSlug) setSlug(taoTenMien(e.target.value));
              }}
            />
          </label>
          <label className="field">
            <span className="field-label">Tên miền (định danh)</span>
            <input
              className="input mono"
              value={slug}
              required
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              onChange={(e) => {
                setTuSuaSlug(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
            <span className="field-hint">Chữ thường, số và dấu gạch; không đổi được sau khi tạo. Xuất hiện trong nội dung chuyển khoản.</span>
          </label>
        </div>
      </Card>

      <Card title="Gói và dùng thử">
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Gói</span>
            <select className="input" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
              {plans.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name} — {p.priceMonthly > 0 ? `${vnd(p.priceMonthly)}đ/tháng` : 'miễn phí'}
                </option>
              ))}
            </select>
            {goi && (
              <span className="field-hint">
                {goi.maxMembers ?? '∞'} hội viên · {goi.maxTrainers ?? '∞'} HLV · {goi.maxMessagesMonth ?? '∞'} tin Zalo/tháng
              </span>
            )}
          </label>
          <label className="field">
            <span className="field-label">Số ngày dùng thử</span>
            <input
              className="input tabular"
              type="number"
              min={0}
              max={90}
              value={trialDays}
              onChange={(e) => setTrialDays(Number(e.target.value))}
            />
            <span className="field-hint">0 = không dùng thử, phát hành hoá đơn kỳ đầu ngay.</span>
          </label>
        </div>
      </Card>

      <Card title="Chủ phòng" desc="Người được quyền cao nhất trong phòng. Số đã có tài khoản thì dùng lại tài khoản đó.">
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Họ tên</span>
            <input className="input" value={ownerName} required minLength={2} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Số điện thoại</span>
            <input
              className="input"
              value={ownerPhone}
              required
              inputMode="tel"
              placeholder="0901 000 001"
              onChange={(e) => setOwnerPhone(e.target.value)}
            />
          </label>
        </div>
      </Card>

      {loi && (
        <Alert tone="danger" icon={TriangleAlert}>
          <span>{loi}</span>
        </Alert>
      )}

      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy && <LoaderCircle size={16} className="spin" />}
          Tạo phòng tập
        </button>
        <Link href="/platform/tenants" className="btn btn-ghost">
          Huỷ
        </Link>
      </div>
    </form>
  );
}
