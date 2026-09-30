'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Archive, ArchiveRestore, Info, LoaderCircle, PackagePlus, Save } from 'lucide-react';
import type { PackageSummary } from '@pt/contracts';
import { Alert, Card } from '../../../components/ui';
import { goiApi } from '../../../lib/client-api';
import { vnd } from '../../../lib/format';
import { LOAI_GOI } from '../../../lib/labels';
import { useAction } from '../../../lib/use-action';

/** '' = theo mặc định của phòng (gửi null), còn lại là giá trị riêng của gói. */
type BaTrangThai = '' | 'true' | 'false';

const tuGoi = (p: PackageSummary | undefined, f: 'lateCancelDeducts' | 'noShowDeducts'): BaTrangThai =>
  !p || p.effectivePolicy.inheritedFields.includes(f) ? '' : p.effectivePolicy[f] ? 'true' : 'false';

/**
 * Thêm / sửa gói tập. Sửa giá và số buổi CHỈ ảnh hưởng hợp đồng bán về sau —
 * hợp đồng đã bán giữ ảnh chụp giá lúc bán. Mã gói không sửa được (đã in trên
 * hợp đồng).
 */
export function PackageForm({ pkg, phong }: { pkg?: PackageSummary; phong: { lateCancelHours: number; lateCancelDeducts: boolean; noShowDeducts: boolean } }) {
  const router = useRouter();
  const sua = !!pkg;
  const [v, setV] = useState({
    code: pkg?.code ?? '',
    name: pkg?.name ?? '',
    kind: pkg?.kind ?? 'PT',
    sessions: pkg?.sessions ?? 10,
    validDays: pkg?.validDays ?? 90,
    price: pkg?.price ?? 0,
    description: pkg?.description ?? '',
    sortOrder: pkg?.sortOrder ?? 0,
  });
  const [gioHuy, setGioHuy] = useState<string>(
    pkg && !pkg.effectivePolicy.inheritedFields.includes('lateCancelHours') ? String(pkg.effectivePolicy.lateCancelHours) : '',
  );
  const [huyTru, setHuyTru] = useState<BaTrangThai>(tuGoi(pkg, 'lateCancelDeducts'));
  const [vangTru, setVangTru] = useState<BaTrangThai>(tuGoi(pkg, 'noShowDeducts'));
  const [xong, setXong] = useState('');
  const { busy, loi, chay } = useAction();

  const dat = (k: keyof typeof v, laSo = false) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setXong('');
    setV((s) => ({ ...s, [k]: laSo ? Math.max(0, Math.trunc(Number(e.target.value) || 0)) : e.target.value }));
  };
  const bool = (x: BaTrangThai) => (x === '' ? null : x === 'true');

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    const body = {
      ...(sua ? {} : { code: v.code.trim() }),
      name: v.name.trim(),
      kind: v.kind,
      sessions: v.sessions,
      validDays: v.validDays,
      price: v.price,
      ...(v.description.trim() ? { description: v.description.trim() } : {}),
      sortOrder: v.sortOrder,
      lateCancelHours: gioHuy === '' ? null : Math.max(0, Math.trunc(Number(gioHuy))),
      lateCancelDeducts: bool(huyTru),
      noShowDeducts: bool(vangTru),
    };
    const r = await chay(() =>
      sua ? goiApi(`packages/${pkg.id}`, { method: 'PATCH', body }) : goiApi<{ id: string }>('packages', { method: 'POST', body }),
    );
    if (r === undefined) return;
    if (sua) {
      setXong('Đã lưu.');
      router.refresh();
    } else router.push('/packages');
  }

  async function doiBan(ban: boolean) {
    if (!pkg) return;
    if (!ban && !confirm(`Ngừng bán “${pkg.name}”? Hợp đồng đã bán vẫn dùng bình thường.`)) return;
    const r = await chay(() =>
      ban ? goiApi(`packages/${pkg.id}`, { method: 'PATCH', body: { isActive: true } }) : goiApi(`packages/${pkg.id}`, { method: 'DELETE' }),
    );
    if (r !== undefined) {
      setXong(ban ? 'Đã mở bán lại.' : 'Đã ngừng bán.');
      router.refresh();
    }
  }

  const macDinh = (b: boolean) => `Theo phòng (${b ? 'trừ buổi' : 'không trừ'})`;

  return (
    <form onSubmit={luu} className="stack" style={{ gap: 20, maxWidth: 860 }}>
      <Card title="Thông tin gói">
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">Mã gói</span>
              <input className="input" required maxLength={32} value={v.code} onChange={dat('code')} disabled={sua} placeholder="VD: PT10" />
              {sua && <span className="field-hint">Mã không đổi được — đã in trên hợp đồng.</span>}
            </label>
            <label className="field">
              <span className="field-label">Tên gói</span>
              <input className="input" required minLength={2} maxLength={160} value={v.name} onChange={dat('name')} />
            </label>
            <label className="field">
              <span className="field-label">Loại</span>
              <select className="input" value={v.kind} onChange={dat('kind')}>
                {Object.entries(LOAI_GOI).map(([k, x]) => (
                  <option key={k} value={k}>{x.text}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Số buổi</span>
              <input className="input tabular" type="number" required min={1} max={1000} value={v.sessions} onChange={dat('sessions', true)} />
            </label>
            <label className="field">
              <span className="field-label">Hạn dùng (ngày)</span>
              <input className="input tabular" type="number" required min={1} max={3650} value={v.validDays} onChange={dat('validDays', true)} />
            </label>
            <label className="field">
              <span className="field-label">Giá (₫)</span>
              <input className="input tabular" type="number" required min={0} step={10000} value={v.price} onChange={dat('price', true)} />
              <span className="field-hint">
                {vnd(v.price)} ₫{v.sessions > 0 ? ` · ${vnd(Math.round(v.price / v.sessions))} ₫/buổi` : ''}
              </span>
            </label>
            <label className="field">
              <span className="field-label">Thứ tự hiển thị</span>
              <input className="input tabular" type="number" min={0} max={9999} value={v.sortOrder} onChange={dat('sortOrder', true)} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Mô tả cho khách <span className="faint">(không bắt buộc)</span></span>
            <textarea className="input" rows={2} maxLength={2000} value={v.description} onChange={dat('description')} />
          </label>
          {sua && pkg.soldCount > 0 && (
            <Alert tone="info" icon={Info}>
              <span>
                Đã bán {pkg.soldCount} hợp đồng. Đổi giá / số buổi chỉ áp cho hợp đồng bán từ giờ; hợp đồng cũ giữ nguyên.
              </span>
            </Alert>
          )}
        </div>
      </Card>

      <Card title="Chính sách riêng" desc="Để “Theo phòng” thì gói tự đổi theo khi chủ phòng sửa chính sách chung.">
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Huỷ muộn nếu trong vòng (giờ)</span>
            <input className="input tabular" type="number" min={0} max={168} value={gioHuy} onChange={(e) => { setXong(''); setGioHuy(e.target.value); }}
              placeholder={`Theo phòng (${phong.lateCancelHours} giờ)`} />
            <span className="field-hint">Để trống = theo phòng.</span>
          </label>
          <label className="field">
            <span className="field-label">Huỷ muộn</span>
            <select className="input" value={huyTru} onChange={(e) => { setXong(''); setHuyTru(e.target.value as BaTrangThai); }}>
              <option value="">{macDinh(phong.lateCancelDeducts)}</option>
              <option value="true">Trừ buổi</option>
              <option value="false">Không trừ</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Vắng không báo</span>
            <select className="input" value={vangTru} onChange={(e) => { setXong(''); setVangTru(e.target.value as BaTrangThai); }}>
              <option value="">{macDinh(phong.noShowDeducts)}</option>
              <option value="true">Trừ buổi</option>
              <option value="false">Không trừ</option>
            </select>
          </label>
        </div>
      </Card>

      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <LoaderCircle size={16} className="spin" /> : sua ? <Save size={16} /> : <PackagePlus size={16} />}
            {sua ? 'Lưu thay đổi' : 'Thêm gói'}
          </button>
          {xong && <span className="small text-success">{xong}</span>}
          {loi && <span className="small text-danger" role="alert">{loi}</span>}
        </div>
        {sua &&
          (pkg.isActive ? (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void doiBan(false)}>
              <Archive size={16} /> Ngừng bán
            </button>
          ) : (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void doiBan(true)}>
              <ArchiveRestore size={16} /> Mở bán lại
            </button>
          ))}
      </div>
    </form>
  );
}
