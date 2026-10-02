'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CalendarPlus, CircleCheck, FilePlus2, LoaderCircle, Lock, LockOpen, PackageOpen, PowerOff } from 'lucide-react';
import type { PlanInfo, SubscriptionStatus, TenantStatus } from '@pt/contracts';
import { goiApi, thongBaoLoi } from '../../../../lib/client-api';
import { vnd } from '../../../../lib/format';

type CheDo = 'plan' | 'trial' | 'invoice' | 'suspend' | 'reactivate' | 'close';

const MO_TA: Record<CheDo, string> = {
  plan: 'Hạn mức đổi NGAY. Hoá đơn đang mở giữ giá cũ — muốn thu theo giá mới thì huỷ hoá đơn đó, job sẽ phát hành lại theo gói mới.',
  trial: 'Kéo dài kỳ dùng thử. Hoá đơn kỳ đầu đang mở (nếu có) sẽ bị huỷ để job phát hành lại đúng ngày; phòng đang quá hạn/khoá do nợ được mở lại.',
  invoice: 'Phát hành hoá đơn cho kỳ kế tiếp ngay, không chờ job. Bỏ trống số tiền = giá gói; khác giá gói thì phải ghi chú.',
  suspend: 'Khoá TAY: phòng chỉ còn xem được, không ghi được gì. Trả tiền KHÔNG tự mở khoá tay — phải mở ở đây.',
  reactivate: 'Mở khoá: trạng thái lấy lại theo thuê bao. Phòng còn nợ sẽ về "quá hạn" và job có thể khoá lại — mở khoá không phải xoá nợ.',
  close: 'Đóng phòng: không ai đăng nhập được nữa, thuê bao huỷ, hoá đơn đang mở bị huỷ. Dữ liệu vẫn giữ nguyên.',
};

export function TenantActions({
  tenantId,
  status,
  subscriptionStatus,
  planCode,
  plans,
  hasOpenInvoice,
  canClose,
}: {
  tenantId: string;
  status: TenantStatus;
  subscriptionStatus: SubscriptionStatus;
  planCode: string;
  plans: PlanInfo[];
  hasOpenInvoice: boolean;
  canClose: boolean;
}) {
  const router = useRouter();
  const [cheDo, setCheDo] = useState<CheDo | null>(null);
  const [plan, setPlan] = useState(planCode);
  const [days, setDays] = useState(7);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState('');

  if (status === 'CLOSED') return <p className="small muted" style={{ margin: 0 }}>Phòng đã đóng — không còn thao tác nào.</p>;

  const nut: { k: CheDo; label: string; icon: typeof Lock; hien: boolean; nguy?: boolean }[] = [
    { k: 'plan', label: 'Đổi gói', icon: PackageOpen, hien: true },
    { k: 'trial', label: 'Gia hạn dùng thử', icon: CalendarPlus, hien: subscriptionStatus === 'TRIALING' || subscriptionStatus === 'PAST_DUE' },
    { k: 'invoice', label: 'Phát hành hoá đơn', icon: FilePlus2, hien: !hasOpenInvoice },
    { k: 'suspend', label: 'Khoá phòng', icon: Lock, hien: status !== 'SUSPENDED', nguy: true },
    { k: 'reactivate', label: 'Mở khoá', icon: LockOpen, hien: status === 'SUSPENDED' },
    { k: 'close', label: 'Đóng phòng', icon: PowerOff, hien: canClose, nguy: true },
  ];

  const canGhiChu = cheDo === 'suspend' || cheDo === 'reactivate' || cheDo === 'close';

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    if (!cheDo) return;
    if (cheDo === 'close' && !window.confirm('Đóng phòng này? Không ai trong phòng đăng nhập được nữa.')) return;
    setBusy(true);
    setLoi('');
    const ghiChu = note.trim() ? { note: note.trim() } : {};
    try {
      if (cheDo === 'plan') await goiApi(`platform/tenants/${tenantId}/plan`, { method: 'PATCH', body: { planCode: plan, ...ghiChu } });
      else if (cheDo === 'trial') await goiApi(`platform/tenants/${tenantId}/extend-trial`, { method: 'POST', body: { days, ...ghiChu } });
      else if (cheDo === 'invoice')
        await goiApi(`platform/tenants/${tenantId}/invoices`, {
          method: 'POST',
          body: { ...(amount ? { amount: Number(amount) } : {}), ...ghiChu },
        });
      else await goiApi(`platform/tenants/${tenantId}/${cheDo}`, { method: 'POST', body: { note: note.trim() } });
      setXong(nut.find((n) => n.k === cheDo)!.label + ': xong');
      setCheDo(null);
      setNote('');
      setAmount('');
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        {nut
          .filter((n) => n.hien)
          .map(({ k, label, icon: Icon, nguy }) => (
            <button
              key={k}
              type="button"
              className={cheDo === k ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
              style={nguy && cheDo !== k ? { color: 'var(--danger)' } : undefined}
              onClick={() => {
                setCheDo((o) => (o === k ? null : k));
                setLoi('');
                setXong('');
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
      </div>

      {xong && !cheDo && (
        <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}>
          <CircleCheck size={15} /> {xong}
        </p>
      )}

      {cheDo && (
        <form className="panel stack" style={{ gap: 12 }} onSubmit={gui}>
          <p className="small muted" style={{ margin: 0 }}>
            {MO_TA[cheDo]}
          </p>
          {cheDo === 'plan' && (
            <label className="field">
              <span className="field-label">Gói mới</span>
              <select className="input" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {plans.map((p) => (
                  <option key={p.code} value={p.code} disabled={p.code === planCode}>
                    {p.name} — {p.priceMonthly > 0 ? `${vnd(p.priceMonthly)}đ/tháng` : 'miễn phí'}
                    {p.code === planCode ? ' (đang dùng)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          {cheDo === 'trial' && (
            <label className="field">
              <span className="field-label">Thêm số ngày</span>
              <input className="input tabular" type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
            </label>
          )}
          {cheDo === 'invoice' && (
            <label className="field">
              <span className="field-label">Số tiền (đ)</span>
              <input
                className="input tabular"
                type="number"
                min={0}
                step={1000}
                value={amount}
                placeholder="Bỏ trống = giá gói"
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
          )}
          <label className="field">
            <span className="field-label">{canGhiChu ? 'Lý do (bắt buộc)' : 'Ghi chú'}</span>
            <input
              className="input"
              value={note}
              required={canGhiChu}
              minLength={canGhiChu ? 3 : undefined}
              onChange={(e) => setNote(e.target.value)}
              placeholder={cheDo === 'suspend' ? 'VD: vi phạm điều khoản, chủ phòng yêu cầu tạm dừng' : undefined}
            />
          </label>
          {loi && (
            <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
              {loi}
            </p>
          )}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || (cheDo === 'plan' && plan === planCode)}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {nut.find((n) => n.k === cheDo)!.label}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setCheDo(null)} disabled={busy}>
              Quay lại
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
