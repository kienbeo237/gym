'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LoaderCircle, Plus, ShoppingCart, Trash2, TriangleAlert } from 'lucide-react';
import type { PackageSummary, SellPackageResponse, TrainerSummary } from '@pt/contracts';
import { Alert, Card } from '../../../../../components/ui';
import { goiApi } from '../../../../../lib/client-api';
import { dichNgay, ngayVN, vnd } from '../../../../../lib/format';
import { HINH_THUC_TT, LOAI_GOI } from '../../../../../lib/labels';
import { khoaMoi, useAction } from '../../../../../lib/use-action';

type Dot = { dueDate: string; amount: number };

/** Cộng tháng theo lịch, giữ ngày (31/1 + 1 tháng -> 28/2 hoặc 29/2). */
function congThang(d: string, n: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const cuoiThang = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  const t = new Date(Date.UTC(y, m - 1 + n, Math.min(day, cuoiThang)));
  return t.toISOString().slice(0, 10);
}

/**
 * Chia đều theo bội 1.000đ, phần lẻ dồn vào đợt ĐẦU (thu ngay lúc ký, khách
 * dễ chấp nhận hơn là một đợt cuối lẻ tẻ).
 */
function chiaDeu(tong: number, n: number, dau: string): Dot[] {
  const moi = Math.floor(tong / n / 1000) * 1000;
  return Array.from({ length: n }, (_, i) => ({
    dueDate: congThang(dau, i),
    amount: i === 0 ? tong - moi * (n - 1) : moi,
  }));
}

export function SellForm({
  memberId,
  packages,
  trainers,
  defaultTrainerId,
}: {
  memberId: string;
  packages: PackageSummary[];
  trainers: TrainerSummary[];
  defaultTrainerId?: string;
}) {
  const router = useRouter();
  const homNay = ngayVN();
  const [khoa] = useState(khoaMoi);
  const [tplId, setTplId] = useState(packages[0]?.id ?? '');
  const tpl = packages.find((p) => p.id === tplId);
  const [trainerId, setTrainerId] = useState(defaultTrainerId ?? '');
  const [soldById, setSoldById] = useState('');
  const [giam, setGiam] = useState(0);
  const [batDau, setBatDau] = useState(homNay);
  const [note, setNote] = useState('');
  const [traGop, setTraGop] = useState(false);
  const [soDot, setSoDot] = useState(3);
  const [dots, setDots] = useState<Dot[]>([]);
  const [thuNgay, setThuNgay] = useState(true);
  const [soTienThu, setSoTienThu] = useState<number | null>(null);
  const [hinhThuc, setHinhThuc] = useState('CASH');
  const [thamChieu, setThamChieu] = useState('');
  const { busy, loi, setLoi, chay } = useAction();

  const tong = Math.max(0, (tpl?.price ?? 0) - giam);
  const canPT = tpl ? tpl.kind !== 'GYM' : false;
  const tongDot = dots.reduce((s, d) => s + d.amount, 0);
  // Mặc định thu: trả một lần -> cả hoá đơn; trả góp -> đúng đợt 1.
  const thuMacDinh = traGop ? (dots[0]?.amount ?? 0) : tong;
  const thu = thuNgay ? (soTienThu ?? thuMacDinh) : 0;

  const lechDot = traGop && tongDot !== tong;
  // Tiền thu lúc ký của hợp đồng trả góp ghi thẳng vào ĐỢT 1 (sale.service) —
  // thu hơn đợt 1 thì dùng nút Thu tiền ở hoá đơn, nơi có tự phân bổ qua các đợt.
  const tranThu = traGop ? (dots[0]?.amount ?? 0) : tong;
  const loiThu = thu > tranThu;

  const chiaLai = (n = soDot, t = tong) => setDots(chiaDeu(t, n, homNay));

  const tomTat = useMemo(() => {
    if (!tpl) return '';
    return `${tpl.sessions} buổi · dùng trong ${tpl.validDays} ngày (tới ${dichNgay(batDau, tpl.validDays)})`;
  }, [tpl, batDau]);

  async function ban(e: React.FormEvent) {
    e.preventDefault();
    if (!tpl) return;
    if (canPT && !trainerId) {
      setLoi('Gói này cần chọn huấn luyện viên phụ trách');
      return;
    }
    const r = await chay(() =>
      goiApi<SellPackageResponse>('sales', {
        method: 'POST',
        body: {
          memberId,
          templateId: tpl.id,
          ...(trainerId ? { trainerId } : {}),
          ...(soldById ? { soldById } : {}),
          discount: giam,
          startsOn: batDau,
          ...(note.trim() ? { note: note.trim() } : {}),
          installments: traGop ? dots : [],
          ...(thu > 0
            ? { initialPayment: { amount: thu, method: hinhThuc, ...(thamChieu.trim() ? { reference: thamChieu.trim() } : {}) } }
            : {}),
          idempotencyKey: khoa,
        },
      }),
    );
    if (r) router.push(`/invoices/${r.invoiceId}`);
  }

  if (packages.length === 0) {
    return (
      <Alert tone="warning" icon={TriangleAlert}>
        <span>Chưa có gói tập nào đang bán. Thêm gói ở mục Gói tập trước.</span>
      </Alert>
    );
  }

  return (
    <form onSubmit={ban} className="stack" style={{ gap: 20, maxWidth: 860 }}>
      <Card title="Gói tập">
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Gói</span>
              <select className="input" value={tplId} onChange={(e) => { setTplId(e.target.value); setDots([]); setTraGop(false); setSoTienThu(null); }}>
                {packages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {vnd(p.price)} ₫ ({LOAI_GOI[p.kind]?.text ?? p.kind})
                  </option>
                ))}
              </select>
              <span className="field-hint">{tomTat}</span>
            </label>
            <label className="field">
              <span className="field-label">Ngày bắt đầu</span>
              <input className="input" type="date" value={batDau} min={dichNgay(homNay, -30)} onChange={(e) => setBatDau(e.target.value)} required />
            </label>
            <label className="field">
              <span className="field-label">Huấn luyện viên phụ trách{!canPT && <span className="faint"> (không bắt buộc)</span>}</span>
              <select className="input" value={trainerId} onChange={(e) => setTrainerId(e.target.value)} required={canPT}>
                <option value="">— Chọn —</option>
                {trainers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({t.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Người bán (hưởng hoa hồng bán)</span>
              <select className="input" value={soldById} onChange={(e) => setSoldById(e.target.value)}>
                <option value="">Như HLV phụ trách</option>
                {trainers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.fullName} ({t.code})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Giảm giá (₫)</span>
              <input className="input tabular" type="number" min={0} max={tpl?.price ?? 0} step={1000} value={giam}
                onChange={(e) => { const g = Math.max(0, Math.trunc(Number(e.target.value) || 0)); setGiam(g); setSoTienThu(null); if (traGop) chiaLai(soDot, Math.max(0, (tpl?.price ?? 0) - g)); }} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Ghi chú hợp đồng <span className="faint">(không bắt buộc)</span></span>
            <input className="input" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
          <div className="row panel" style={{ gap: 12 }}>
            <span className="muted">Phải thu</span>
            <strong style={{ fontSize: 20 }} className="tabular">{vnd(tong)} ₫</strong>
          </div>
        </div>
      </Card>

      <Card title="Thanh toán">
        <div className="stack" style={{ gap: 16 }}>
          <div className="segmented" role="tablist" aria-label="Hình thức trả">
            <button type="button" role="tab" aria-selected={!traGop} onClick={() => { setTraGop(false); setSoTienThu(null); }}>
              Trả một lần
            </button>
            <button type="button" role="tab" aria-selected={traGop} onClick={() => { setTraGop(true); setSoTienThu(null); chiaLai(); }}>
              Trả góp
            </button>
          </div>

          {traGop && (
            <div className="stack" style={{ gap: 10 }}>
              <div className="row-start" style={{ gap: 10, flexWrap: 'wrap' }}>
                <label className="field" style={{ width: 140 }}>
                  <span className="field-label">Số đợt</span>
                  <input className="input tabular" type="number" min={2} max={24} value={soDot}
                    onChange={(e) => { const n = Math.min(24, Math.max(2, Math.trunc(Number(e.target.value) || 2))); setSoDot(n); chiaLai(n); setSoTienThu(null); }} />
                </label>
                <span className="small muted" style={{ alignSelf: 'end', paddingBottom: 10 }}>Mỗi tháng một đợt, đợt 1 hôm nay. Sửa từng dòng nếu cần.</span>
              </div>
              {dots.map((d, i) => (
                <div key={i} className="repeat-row" style={{ ['--cols' as string]: '48px 1fr 1fr auto' }}>
                  <span className="strong">#{i + 1}</span>
                  <input className="input" type="date" aria-label={`Hạn đợt ${i + 1}`} value={d.dueDate} required
                    onChange={(e) => setDots((s) => s.map((x, j) => (j === i ? { ...x, dueDate: e.target.value } : x)))} />
                  <input className="input tabular" type="number" min={1000} step={1000} aria-label={`Số tiền đợt ${i + 1}`} value={d.amount} required
                    onChange={(e) => { setSoTienThu(null); setDots((s) => s.map((x, j) => (j === i ? { ...x, amount: Math.max(0, Math.trunc(Number(e.target.value) || 0)) } : x))); }} />
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`Xoá đợt ${i + 1}`} disabled={dots.length <= 2}
                    onClick={() => { setDots((s) => s.filter((_, j) => j !== i)); setSoDot((n) => n - 1); }}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-ghost btn-sm" disabled={dots.length >= 24}
                  onClick={() => { setDots((s) => [...s, { dueDate: congThang(s[s.length - 1]?.dueDate ?? homNay, 1), amount: 0 }]); setSoDot((n) => n + 1); }}>
                  <Plus size={14} /> Thêm đợt
                </button>
                <span className={lechDot ? 'small text-danger strong' : 'small muted'}>
                  Tổng các đợt {vnd(tongDot)} ₫{lechDot ? ` — phải bằng ${vnd(tong)} ₫` : ''}
                </span>
              </div>
            </div>
          )}

          <label className="row-start" style={{ gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={thuNgay} onChange={(e) => setThuNgay(e.target.checked)} />
            <span>Thu tiền ngay lúc ký{traGop ? ' (ghi vào đợt 1)' : ''}</span>
          </label>

          {thuNgay && (
            <div className="form-grid">
              <label className="field">
                <span className="field-label">Số tiền thu (₫)</span>
                <input className="input tabular" type="number" min={1000} step={1000} max={tranThu} value={thu}
                  onChange={(e) => setSoTienThu(Math.max(0, Math.trunc(Number(e.target.value) || 0)))} />
                {loiThu && (
                  <span className="field-hint text-danger">
                    {traGop ? `Tối đa bằng đợt 1 (${vnd(tranThu)} ₫). Thu thêm ở màn hoá đơn sau khi bán.` : "Không thu quá số phải thu."}
                  </span>
                )}
              </label>
              <label className="field">
                <span className="field-label">Hình thức</span>
                <select className="input" value={hinhThuc} onChange={(e) => setHinhThuc(e.target.value)}>
                  {Object.entries(HINH_THUC_TT).map(([k, t]) => (
                    <option key={k} value={k}>{t}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field-label">Mã giao dịch <span className="faint">(không bắt buộc)</span></span>
                <input className="input" maxLength={120} value={thamChieu} onChange={(e) => setThamChieu(e.target.value)} />
              </label>
            </div>
          )}
        </div>
      </Card>

      {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
      <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary" type="submit" disabled={busy || !tpl || lechDot || loiThu}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <ShoppingCart size={16} />} Bán gói · {vnd(tong)} ₫
        </button>
        <span className="small muted">
          {thu > 0 ? `Thu ngay ${vnd(thu)} ₫, còn ${vnd(tong - thu)} ₫` : 'Chưa thu tiền — hoá đơn ở trạng thái chưa thu'}
        </span>
      </div>
    </form>
  );
}
