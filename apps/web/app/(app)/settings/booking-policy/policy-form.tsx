'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Save, TriangleAlert } from 'lucide-react';
import type { BookingPolicy, UpdateBookingPolicy } from '@pt/contracts';
import { Alert, Card } from '../../../../components/ui';
import { goiApi, thongBaoLoi } from '../../../../lib/client-api';

/** Cửa sổ điểm danh đóng sau giờ bắt đầu = ân hạn + phần này (CUA_SO_THEM_PHUT ở API). */
const CUA_SO_THEM_PHUT = 240;

const gio = (phut: number) => {
  const h = Math.floor(phut / 60);
  const m = phut % 60;
  return h > 0 ? `${h} giờ${m ? ` ${m} phút` : ''}` : `${m} phút`;
};

function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <label className="switch" title={label}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span />
    </label>
  );
}

function Dong({ title, hint, children }: { title: string; hint: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
      <div className="stack" style={{ gap: 4, minWidth: 0 }}>
        <span className="field-label">{title}</span>
        <span className="small muted">{hint}</span>
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

export function PolicyForm({ policy, readOnly }: { policy: BookingPolicy; readOnly: boolean }) {
  const router = useRouter();
  const [v, setV] = useState<UpdateBookingPolicy>({
    lateCancelHours: policy.lateCancelHours,
    lateCancelDeducts: policy.lateCancelDeducts,
    noShowDeducts: policy.noShowDeducts,
    bookingWindowDays: policy.bookingWindowDays,
    checkinGraceMinutes: policy.checkinGraceMinutes,
    autoNoShow: policy.autoNoShow,
  });
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState(false);

  const dat = <K extends keyof UpdateBookingPolicy>(k: K, val: UpdateBookingPolicy[K]) => {
    setXong(false);
    setV((s) => ({ ...s, [k]: val }));
  };
  const so = (k: 'lateCancelHours' | 'bookingWindowDays' | 'checkinGraceMinutes') => (e: React.ChangeEvent<HTMLInputElement>) =>
    dat(k, Math.max(0, Math.trunc(Number(e.target.value) || 0)));

  const dongCua = v.checkinGraceMinutes + CUA_SO_THEM_PHUT;
  const vuaBat = v.autoNoShow && !policy.autoNoShow;
  const doi = (Object.keys(v) as (keyof UpdateBookingPolicy)[]).some((k) => v[k] !== policy[k]);

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    if (vuaBat && !confirm(
      `Bật tự đánh vắng: mọi buổi đã đặt mà quá ${gio(dongCua)} sau giờ bắt đầu vẫn chưa điểm danh sẽ bị ghi VẮNG` +
        (v.noShowDeducts ? ' và TRỪ BUỔI' : '') + '. Tiếp tục?',
    )) return;
    setBusy(true);
    setLoi('');
    try {
      await goiApi('settings/booking-policy', { method: 'PUT', body: v });
      setXong(true);
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 20 }} onSubmit={luu}>
      <Card title="Đặt lịch và huỷ buổi">
        <div className="stack" style={{ gap: 18 }}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Đặt trước tối đa (ngày)</span>
              <input className="input tabular" type="number" min={1} max={365} value={v.bookingWindowDays}
                onChange={so('bookingWindowDays')} disabled={readOnly} required />
              <span className="field-hint">Hội viên không đặt được buổi xa hơn số ngày này.</span>
            </label>
            <label className="field">
              <span className="field-label">Huỷ muộn nếu trong vòng (giờ)</span>
              <input className="input tabular" type="number" min={0} max={168} value={v.lateCancelHours}
                onChange={so('lateCancelHours')} disabled={readOnly} required />
              <span className="field-hint">Huỷ sát giờ hơn mức này tính là huỷ muộn. 0 = không có huỷ muộn.</span>
            </label>
          </div>
          <Dong title="Huỷ muộn có trừ buổi" hint="Mặc định cho mọi gói; gói tập có thể đặt riêng.">
            <Switch label="Huỷ muộn có trừ buổi" checked={v.lateCancelDeducts} disabled={readOnly}
              onChange={(b) => dat('lateCancelDeducts', b)} />
          </Dong>
        </div>
      </Card>

      <Card title="Điểm danh và vắng mặt">
        <div className="stack" style={{ gap: 18 }}>
          <label className="field" style={{ maxWidth: 320 }}>
            <span className="field-label">Ân hạn điểm danh (phút)</span>
            <input className="input tabular" type="number" min={0} max={240} value={v.checkinGraceMinutes}
              onChange={so('checkinGraceMinutes')} disabled={readOnly} required />
            <span className="field-hint">
              Cửa sổ điểm danh đóng sau giờ bắt đầu <b>{gio(dongCua)}</b> (ân hạn + 4 giờ cho lễ tân xử lý).
            </span>
          </label>
          <Dong title="Vắng mặt có trừ buổi" hint="Áp khi lễ tân đánh vắng, và khi hệ thống tự đánh vắng.">
            <Switch label="Vắng mặt có trừ buổi" checked={v.noShowDeducts} disabled={readOnly}
              onChange={(b) => dat('noShowDeducts', b)} />
          </Dong>
          <Dong
            title="Tự đánh vắng"
            hint={<>Hệ thống tự ghi VẮNG cho buổi quá {gio(dongCua)} mà chưa điểm danh (quét 15 phút một lần).</>}
          >
            <Switch label="Tự đánh vắng" checked={v.autoNoShow} disabled={readOnly}
              onChange={(b) => dat('autoNoShow', b)} />
          </Dong>
          {v.autoNoShow && (
            <Alert tone="warning" icon={TriangleAlert}>
              <span>
                {v.noShowDeducts
                  ? 'Buổi bị tự đánh vắng sẽ bị TRỪ vào gói như khi lễ tân đánh vắng. '
                  : 'Buổi bị tự đánh vắng chỉ ghi trạng thái, không trừ buổi. '}
                Gói đang bảo lưu hoặc đã hết buổi thì hệ thống <b>không tự trừ</b> — lễ tân tự quyết. Buổi quên điểm
                danh sẽ thành vắng: hãy chắc lễ tân điểm danh đều trước khi bật.
              </span>
            </Alert>
          )}
        </div>
      </Card>

      {!readOnly && (
        <div className="row-start" style={{ gap: 12 }}>
          <button className="btn btn-primary" type="submit" disabled={busy || !doi}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} Lưu chính sách
          </button>
          {xong && !doi && <span className="small text-success">Đã lưu.</span>}
          {loi && (
            <span className="small text-danger" role="alert">
              {loi}
            </span>
          )}
        </div>
      )}
    </form>
  );
}
