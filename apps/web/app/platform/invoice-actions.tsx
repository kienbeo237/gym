'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CircleCheck, Gift, LoaderCircle } from 'lucide-react';
import { goiApi, thongBaoLoi } from '../../lib/client-api';
import { vnd } from '../../lib/format';

type CheDo = 'confirm' | 'waive' | 'void';

const MO_TA: Record<CheDo, string> = {
  confirm: 'Chỉ bấm sau khi đã thấy khoản tiền trên sao kê. Phòng được gia hạn tới hết kỳ và mở khoá nếu đang bị khoá do nợ.',
  waive: 'Tặng kỳ này: phòng được gia hạn như đã trả, nhưng doanh thu ghi 0đ. Ghi rõ lý do.',
  void: 'Huỷ hoá đơn (phát hành nhầm, sai số tiền). Kỳ này trống hoá đơn — phát hành lại ở trang phòng, hoặc để job tự phát hành.',
};

/**
 * Xử lý MỘT hoá đơn đang chờ: xác nhận đã nhận tiền, miễn phí, hoặc huỷ.
 *
 * Mọi quy tắc (thiếu tiền, dư tiền phải ghi chú, mã giao dịch đã dùng, xác
 * nhận hai lần) nằm ở API và hàm SQL — ở đây chỉ hiện câu lỗi API trả về.
 */
export function InvoiceActions({ id, amount, transferRef }: { id: string; amount: number; transferRef: string }) {
  const router = useRouter();
  const [cheDo, setCheDo] = useState<CheDo | null>(null);
  const [paidAmount, setPaidAmount] = useState(amount);
  const [bankTxnRef, setBankTxnRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState('');

  function mo(c: CheDo) {
    setCheDo((o) => (o === c ? null : c));
    setLoi('');
    setNote('');
  }

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    if (!cheDo) return;
    setBusy(true);
    setLoi('');
    try {
      const body =
        cheDo === 'confirm' ? { paidAmount, bankTxnRef, ...(note ? { note } : {}) } : { note };
      await goiApi(`platform/invoices/${id}/${cheDo}`, { method: 'POST', body });
      setXong(
        cheDo === 'confirm' ? `Đã xác nhận ${vnd(paidAmount)}đ cho ${transferRef}` : cheDo === 'waive' ? 'Đã miễn phí kỳ này' : 'Đã huỷ hoá đơn',
      );
      setCheDo(null);
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  if (xong) return <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}><CircleCheck size={15} /> {xong}</p>;

  const du = cheDo === 'confirm' && paidAmount > amount;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button type="button" className={cheDo === 'confirm' ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'} onClick={() => mo('confirm')}>
          <CircleCheck size={14} /> Đã nhận tiền
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={cheDo === 'waive'} onClick={() => mo('waive')}>
          <Gift size={14} /> Miễn phí
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={cheDo === 'void'} onClick={() => mo('void')}>
          <Ban size={14} /> Huỷ
        </button>
      </div>

      {cheDo && (
        <form className="panel stack" style={{ gap: 12 }} onSubmit={gui}>
          <p className="small muted" style={{ margin: 0 }}>
            {MO_TA[cheDo]}
          </p>
          {cheDo === 'confirm' && (
            <div className="form-grid">
              <label className="field">
                <span className="field-label">Số tiền trên sao kê</span>
                <input
                  className="input tabular"
                  type="number"
                  min={0}
                  step={1000}
                  value={paidAmount}
                  required
                  onChange={(e) => setPaidAmount(Number(e.target.value))}
                />
                <span className="field-hint">Phải thu {vnd(amount)}đ</span>
              </label>
              <label className="field">
                <span className="field-label">Mã giao dịch ngân hàng</span>
                <input
                  className="input mono"
                  value={bankTxnRef}
                  required
                  minLength={3}
                  placeholder="VD: FT26274XXXXX"
                  onChange={(e) => setBankTxnRef(e.target.value)}
                />
                <span className="field-hint">Mỗi giao dịch chỉ tất toán được một hoá đơn.</span>
              </label>
            </div>
          )}
          {(cheDo !== 'confirm' || du) && (
            <label className="field">
              <span className="field-label">{du ? 'Xử lý phần dư' : 'Lý do'}</span>
              <input
                className="input"
                value={note}
                required
                minLength={3}
                placeholder={du ? 'VD: trừ vào kỳ sau' : cheDo === 'waive' ? 'VD: tặng tháng khai trương' : 'VD: phát hành nhầm số tiền'}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          )}
          {loi && (
            <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
              {loi}
            </p>
          )}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {cheDo === 'confirm' ? 'Xác nhận đã nhận tiền' : cheDo === 'waive' ? 'Miễn phí kỳ này' : 'Huỷ hoá đơn'}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setCheDo(null)} disabled={busy}>
              Thôi
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
