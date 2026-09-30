'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Banknote, CircleCheck, LoaderCircle, Undo2 } from 'lucide-react';
import type { InvoiceDetail, PaymentResult } from '@pt/contracts';
import { goiApi } from '../../../../lib/client-api';
import { vnd } from '../../../../lib/format';
import { HINH_THUC_TT } from '../../../../lib/labels';
import { khoaMoi, useAction } from '../../../../lib/use-action';

type Mo = 'thu' | 'hoan' | 'huy' | null;

/**
 * Thu tiền / hoàn tiền / huỷ hoá đơn. Mọi quy tắc tiền nằm ở API (chặn thu
 * vượt, hoàn quá số đã thu, huỷ hoá đơn đã có tiền); màn này chỉ đặt giá trị
 * mặc định hợp lý và hiện câu lỗi API trả về.
 */
export function InvoiceActions({
  inv,
  coTheThu,
  coTheHoanHuy,
}: {
  inv: InvoiceDetail;
  /** Lễ tân trở lên. */
  coTheThu: boolean;
  /** Chủ phòng / quản lý. */
  coTheHoanHuy: boolean;
}) {
  const router = useRouter();
  const [mo, setMo] = useState<Mo>(null);
  const [khoa, setKhoa] = useState(khoaMoi);
  const [soTien, setSoTien] = useState(0);
  const [hinhThuc, setHinhThuc] = useState('CASH');
  const [dot, setDot] = useState('');
  const [thamChieu, setThamChieu] = useState('');
  const [ghiChu, setGhiChu] = useState('');
  const [ketQua, setKetQua] = useState<React.ReactNode>(null);
  const { busy, loi, setLoi, chay } = useAction();

  const conDot = inv.schedule.filter((s) => s.status !== 'PAID' && s.status !== 'WAIVED' && s.paidAmount < s.amount);
  const dong = inv.status === 'VOID' || inv.status === 'REFUNDED';
  const choThu = coTheThu && !dong && inv.outstanding > 0;
  const choHoan = coTheHoanHuy && inv.paidAmount > 0 && inv.status !== 'VOID';
  const choHuy = coTheHoanHuy && inv.paidAmount === 0 && inv.status !== 'VOID';

  const bat = (m: Mo) => {
    setMo((o) => (o === m ? null : m));
    setLoi('');
    setKetQua(null);
    // Khoá chống trùng sinh lúc MỞ form: bấm "Xác nhận" hai lần vẫn một khoá.
    setKhoa(khoaMoi());
    setDot('');
    setThamChieu('');
    setGhiChu('');
    setSoTien(m === 'thu' ? inv.outstanding : m === 'hoan' ? inv.paidAmount : 0);
  };

  async function thu() {
    const r = await chay(() =>
      goiApi<PaymentResult>(`invoices/${inv.id}/payments`, {
        method: 'POST',
        body: {
          amount: soTien,
          method: hinhThuc,
          ...(dot ? { scheduleId: dot } : {}),
          ...(thamChieu.trim() ? { reference: thamChieu.trim() } : {}),
          ...(ghiChu.trim() ? { note: ghiChu.trim() } : {}),
          idempotencyKey: khoa,
        },
      }),
    );
    if (!r) return;
    const phan = (r.allocations ?? []).filter((a) => a.seq !== null);
    setKetQua(
      <>
        Đã thu {vnd(soTien)} ₫
        {phan.length > 0 && <> — vào {phan.map((a) => `đợt ${a.seq}: ${vnd(a.amount)} ₫`).join(', ')}</>}
        {r.outstanding > 0 ? `. Còn ${vnd(r.outstanding)} ₫.` : '. Hoá đơn đã thu đủ.'}
      </>,
    );
    setMo(null);
    router.refresh();
  }

  async function hoan() {
    const r = await chay(() =>
      goiApi<PaymentResult>(`invoices/${inv.id}/refunds`, {
        method: 'POST',
        body: { amount: soTien, method: hinhThuc, reason: ghiChu.trim(), idempotencyKey: khoa },
      }),
    );
    if (!r) return;
    setKetQua(<>Đã hoàn {vnd(soTien)} ₫. Hoa hồng bán của phần này đã được trừ lại.</>);
    setMo(null);
    router.refresh();
  }

  async function huy() {
    if (!confirm(`Huỷ hoá đơn ${inv.code}? Hợp đồng đi kèm cũng bị huỷ.`)) return;
    const r = await chay(() => goiApi(`invoices/${inv.id}/void`, { method: 'POST', body: { reason: ghiChu.trim() } }));
    if (r === undefined) return;
    setKetQua(<>Đã huỷ hoá đơn.</>);
    setMo(null);
    router.refresh();
  }

  if (!choThu && !choHoan && !choHuy && !ketQua) return null;

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        {choThu && (
          <button type="button" className={mo === 'thu' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} aria-pressed={mo === 'thu'} onClick={() => bat('thu')}>
            <Banknote size={14} /> Thu tiền
          </button>
        )}
        {choHoan && (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mo === 'hoan'} onClick={() => bat('hoan')}>
            <Undo2 size={14} /> Hoàn tiền
          </button>
        )}
        {choHuy && (
          <button type="button" className="btn btn-ghost btn-sm" aria-pressed={mo === 'huy'} onClick={() => bat('huy')}>
            <Ban size={14} /> Huỷ hoá đơn
          </button>
        )}
      </div>

      {ketQua && (
        <p className="small text-success row-start" style={{ gap: 6, margin: 0, alignItems: 'flex-start' }}>
          <CircleCheck size={15} style={{ flexShrink: 0, marginTop: 2 }} /> <span>{ketQua}</span>
        </p>
      )}

      {mo && (
        <form
          className="panel stack"
          style={{ gap: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void (mo === 'thu' ? thu() : mo === 'hoan' ? hoan() : huy());
          }}
        >
          {mo !== 'huy' && (
            <div className="form-grid">
              <label className="field">
                <span className="field-label">Số tiền {mo === 'thu' ? 'thu' : 'hoàn'} (₫)</span>
                <input className="input tabular" type="number" required min={1000} step={1000}
                  max={mo === 'thu' ? inv.outstanding : inv.paidAmount} value={soTien}
                  onChange={(e) => setSoTien(Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
                <span className="field-hint">
                  {mo === 'thu' ? `Còn phải thu ${vnd(inv.outstanding)} ₫` : `Đã thu ${vnd(inv.paidAmount)} ₫`}
                </span>
              </label>
              <label className="field">
                <span className="field-label">Hình thức</span>
                <select className="input" value={hinhThuc} onChange={(e) => setHinhThuc(e.target.value)}>
                  {Object.entries(HINH_THUC_TT).map(([k, t]) => (
                    <option key={k} value={k}>{t}</option>
                  ))}
                </select>
              </label>
              {mo === 'thu' && inv.isInstallment && conDot.length > 0 && (
                <label className="field">
                  <span className="field-label">Vào đợt</span>
                  <select className="input" value={dot} onChange={(e) => setDot(e.target.value)}>
                    <option value="">Tự phân bổ (đợt đến hạn sớm nhất trước)</option>
                    {conDot.map((s) => (
                      <option key={s.id} value={s.id}>
                        Đợt {s.seq} — còn {vnd(s.amount - s.paidAmount)} ₫
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {mo === 'thu' && (
                <label className="field">
                  <span className="field-label">Mã giao dịch <span className="faint">(không bắt buộc)</span></span>
                  <input className="input" maxLength={120} value={thamChieu} onChange={(e) => setThamChieu(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <label className="field">
            <span className="field-label">
              {mo === 'thu' ? 'Ghi chú' : 'Lý do'}
              {mo !== 'hoan' && <span className="faint"> (không bắt buộc)</span>}
            </span>
            <input className="input" value={ghiChu} maxLength={1000} required={mo === 'hoan'} minLength={mo === 'hoan' ? 3 : undefined}
              onChange={(e) => setGhiChu(e.target.value)}
              placeholder={mo === 'hoan' ? 'VD: Khách chuyển nhà, hoàn phần chưa tập' : undefined} />
          </label>
          {mo === 'huy' && (
            <p className="small muted" style={{ margin: 0 }}>
              Chỉ huỷ được hoá đơn chưa thu đồng nào và hợp đồng chưa dùng buổi nào. Hoá đơn đã có tiền thì dùng hoàn tiền.
            </p>
          )}
          {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || (mo !== 'huy' && soTien <= 0)}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {mo === 'thu' ? `Xác nhận thu ${vnd(soTien)} ₫` : mo === 'hoan' ? `Xác nhận hoàn ${vnd(soTien)} ₫` : 'Huỷ hoá đơn'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMo(null)} disabled={busy}>Thôi</button>
          </div>
        </form>
      )}
    </div>
  );
}
