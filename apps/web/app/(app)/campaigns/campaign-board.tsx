'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Eye, LoaderCircle, Pencil, Play, Plus, X } from 'lucide-react';
import type { CampaignPreview, CampaignRow, CampaignRunResult, ZnsTemplateRow } from '@pt/contracts';
import { Badge } from '../../../components/ui';
import { goiApi, thongBaoLoi } from '../../../lib/client-api';
import { ngayGioVN } from '../../../lib/format';
import { LOAI_CHIEN_DICH, TRANG_THAI_MAU } from '../../../lib/labels';

type Mau = Pick<ZnsTemplateRow, 'code' | 'name' | 'status'>;

/** Mẫu tin hợp lý nhất cho từng loại — người dùng vẫn đổi được. */
const MAU_MAC_DINH: Record<string, string> = {
  LOW_SESSION_BALANCE: 'PACKAGE_LOW_BALANCE',
  PACKAGE_EXPIRING: 'PACKAGE_EXPIRING',
  INACTIVE_MEMBER: 'MEMBER_INACTIVE',
  BIRTHDAY: 'BIRTHDAY_GREETING',
  PAYMENT_DUE: 'PAYMENT_DUE',
};

/** Các mẫu gửi theo sự kiện, không dùng cho chiến dịch. */
const MAU_SU_KIEN = ['OTP_LOGIN', 'CHECKIN_REMAINING', 'SESSION_DEDUCTED'];

// ---- Chạy ngay ----------------------------------------------------------------

export function RunNowButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [kq, setKq] = useState('');

  async function chay() {
    setBusy(true);
    setKq('');
    try {
      const r = await goiApi<CampaignRunResult>('campaigns/run', { method: 'POST' });
      setKq(r.queued > 0 ? `Đã xếp ${r.queued} tin vào hàng gửi` : 'Không có ai mới cần nhắc');
      router.refresh();
    } catch (e) {
      setKq(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row-start" style={{ gap: 10, flexWrap: 'wrap' }}>
      {kq && <span className="small muted">{kq}</span>}
      <button type="button" className="btn btn-secondary" onClick={chay} disabled={busy}>
        {busy ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
        Chạy ngay
      </button>
    </div>
  );
}

// ---- Biểu mẫu dùng chung cho tạo & sửa ---------------------------------------

type GiaTri = {
  code: string;
  name: string;
  triggerType: string;
  threshold: number;
  cooldownDays: number;
  templateCode: string;
  isActive: boolean;
};

function BieuMau({
  dau,
  mau,
  moi,
  onXong,
  onHuy,
}: {
  dau: GiaTri;
  mau: Mau[];
  /** Tạo mới thì được chọn mã và loại; sửa thì không — đổi loại là một chiến dịch khác. */
  moi: boolean;
  onXong: (v: GiaTri) => Promise<void>;
  onHuy: () => void;
}) {
  const [v, setV] = useState(dau);
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const loai = LOAI_CHIEN_DICH[v.triggerType];
  const dat = <K extends keyof GiaTri>(k: K, x: GiaTri[K]) => setV((o) => ({ ...o, [k]: x }));

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    try {
      await onXong(v);
    } catch (e) {
      setLoi(thongBaoLoi(e));
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={gui}>
      {moi && (
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Loại chiến dịch</span>
            <select
              className="input"
              value={v.triggerType}
              onChange={(e) => {
                dat('triggerType', e.target.value);
                dat('templateCode', MAU_MAC_DINH[e.target.value] ?? v.templateCode);
              }}
            >
              {Object.entries(LOAI_CHIEN_DICH).map(([k, x]) => (
                <option key={k} value={k}>
                  {x.text}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Mã (in hoa, không dấu)</span>
            <input
              className="input"
              value={v.code}
              onChange={(e) => dat('code', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              placeholder="VD: INACTIVE_14D"
              required
            />
          </label>
        </div>
      )}
      <label className="field">
        <span className="field-label">Tên hiển thị</span>
        <input className="input" value={v.name} onChange={(e) => dat('name', e.target.value)} required />
      </label>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">{loai?.nguong ?? 'Ngưỡng'}</span>
          <input
            className="input tabular"
            type="number"
            min={0}
            max={365}
            value={v.threshold}
            onChange={(e) => dat('threshold', Number(e.target.value))}
          />
          <span className="field-hint">{loai?.donVi}</span>
        </label>
        <label className="field">
          <span className="field-label">Không nhắc lại trong</span>
          <input
            className="input tabular"
            type="number"
            min={0}
            max={365}
            value={v.cooldownDays}
            onChange={(e) => dat('cooldownDays', Number(e.target.value))}
          />
          <span className="field-hint">ngày, cho cùng một hội viên</span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Mẫu tin</span>
        <select className="input" value={v.templateCode} onChange={(e) => dat('templateCode', e.target.value)}>
          {mau
            .filter((m) => !MAU_SU_KIEN.includes(m.code))
            .map((m) => (
              <option key={m.code} value={m.code}>
                {m.name} — {TRANG_THAI_MAU[m.status]?.text ?? m.status}
              </option>
            ))}
        </select>
      </label>
      {moi && (
        <label className="row-start small" style={{ gap: 8 }}>
          <input type="checkbox" checked={v.isActive} onChange={(e) => dat('isActive', e.target.checked)} />
          Bật ngay sau khi tạo
        </label>
      )}
      {loi && (
        <p className="field-hint text-danger" role="alert">
          {loi}
        </p>
      )}
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
          {busy && <LoaderCircle size={14} className="spin" />}
          {moi ? 'Tạo chiến dịch' : 'Lưu thay đổi'}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onHuy} disabled={busy}>
          Huỷ
        </button>
      </div>
    </form>
  );
}

// ---- Thẻ chiến dịch -------------------------------------------------------------

function TheChienDich({ c, mau }: { c: CampaignRow; mau: Mau[] }) {
  const router = useRouter();
  const [sua, setSua] = useState(false);
  const [bat, setBat] = useState(false);
  const [xemTruoc, setXemTruoc] = useState<CampaignPreview | null>(null);
  const [dangXem, setDangXem] = useState(false);
  const [loi, setLoi] = useState('');

  const loai = LOAI_CHIEN_DICH[c.triggerType];
  const m = mau.find((x) => x.code === c.templateCode);
  const nhanMau = TRANG_THAI_MAU[m?.status ?? 'NOT_SET'];

  async function doiTrangThai() {
    setBat(true);
    setLoi('');
    try {
      await goiApi(`campaigns/${c.id}`, { method: 'PATCH', body: { isActive: !c.isActive } });
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBat(false);
    }
  }

  async function xem() {
    if (xemTruoc) return setXemTruoc(null);
    setDangXem(true);
    setLoi('');
    try {
      setXemTruoc(await goiApi<CampaignPreview>(`campaigns/${c.id}/preview`));
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setDangXem(false);
    }
  }

  return (
    <section className="card camp" data-inactive={!c.isActive}>
      <div className="pkg-head">
        <div style={{ minWidth: 0 }}>
          <div className="pkg-name">{c.name}</div>
          <div className="small muted">
            {loai?.text ?? c.triggerType} · <code>{c.code}</code>
          </div>
        </div>
        <label className="switch" title={c.isActive ? 'Đang bật — bấm để tắt' : 'Đang tắt — bấm để bật'}>
          <input
            type="checkbox"
            role="switch"
            checked={c.isActive}
            onChange={doiTrangThai}
            disabled={bat}
            aria-label={c.isActive ? `Tắt ${c.name}` : `Bật ${c.name}`}
          />
          <span />
        </label>
      </div>

      {sua ? (
        <BieuMau
          moi={false}
          mau={mau}
          dau={{
            code: c.code,
            name: c.name,
            triggerType: c.triggerType,
            threshold: c.threshold,
            cooldownDays: c.cooldownDays,
            templateCode: c.templateCode,
            isActive: c.isActive,
          }}
          onHuy={() => setSua(false)}
          onXong={async (v) => {
            await goiApi(`campaigns/${c.id}`, {
              method: 'PATCH',
              body: { name: v.name, threshold: v.threshold, cooldownDays: v.cooldownDays, templateCode: v.templateCode },
            });
            setSua(false);
            setXemTruoc(null);
            router.refresh();
          }}
        />
      ) : (
        <>
          <div className="camp-rule">
            <div>
              <span className="muted">{loai?.nguong ?? 'Ngưỡng'}</span> <strong className="tabular">{c.threshold}</strong>{' '}
              <span className="muted">{loai?.donVi}</span>
            </div>
            <div className="small muted">
              {c.cooldownDays > 0 ? `Không nhắc lại cùng người trong ${c.cooldownDays} ngày` : 'Mỗi sự kiện nhắc đúng một lần'}
            </div>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <div className="small muted">Mẫu tin</div>
              <div className="small strong">{m?.name ?? c.templateCode}</div>
            </div>
            {nhanMau && <Badge tone={nhanMau.tone}>{nhanMau.text}</Badge>}
          </div>
        </>
      )}

      {xemTruoc && (
        <div className="camp-preview">
          {xemTruoc.blockedReason ? (
            <p className="small text-warning">Chưa gửi được: {xemTruoc.blockedReason}</p>
          ) : null}
          <p className="small">
            <strong>{xemTruoc.matched}</strong> hội viên thoả điều kiện · <strong>{xemTruoc.willSend}</strong> sẽ nhận
            tin ở lần chạy tới
          </p>
          {xemTruoc.sample.length > 0 && (
            <ul className="camp-sample">
              {xemTruoc.sample.map((s, i) => (
                <li key={i}>
                  <span className="strong">{s.memberName}</span>
                  <span className="muted"> — {s.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loi && (
        <p className="field-hint text-danger" role="alert">
          {loi}
        </p>
      )}

      {!sua && (
        <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={xem} disabled={dangXem}>
            {dangXem ? <LoaderCircle size={14} className="spin" /> : xemTruoc ? <X size={14} /> : <Eye size={14} />}
            {xemTruoc ? 'Đóng xem trước' : 'Xem trước'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSua(true)}>
            <Pencil size={14} /> Sửa
          </button>
        </div>
      )}

      <div className="pkg-foot">
        {c.sent30d} tin trong 30 ngày
        {c.lastTriggeredAt && <> · lần gần nhất {ngayGioVN(c.lastTriggeredAt)}</>}
      </div>
    </section>
  );
}

// ---- Bảng chiến dịch ----------------------------------------------------------

export function CampaignBoard({ campaigns, mau }: { campaigns: CampaignRow[]; mau: Mau[] }) {
  const router = useRouter();
  const [tao, setTao] = useState(false);

  return (
    <div className="grid-cards">
      {campaigns.map((c) => (
        <TheChienDich key={c.id} c={c} mau={mau} />
      ))}

      {tao ? (
        <section className="card camp">
          <div className="pkg-name">Chiến dịch mới</div>
          <BieuMau
            moi
            mau={mau}
            dau={{
              code: '',
              name: '',
              triggerType: 'INACTIVE_MEMBER',
              threshold: 14,
              cooldownDays: 14,
              templateCode: 'MEMBER_INACTIVE',
              isActive: true,
            }}
            onHuy={() => setTao(false)}
            onXong={async (v) => {
              await goiApi('campaigns', { method: 'POST', body: v });
              setTao(false);
              router.refresh();
            }}
          />
        </section>
      ) : (
        <button type="button" className="card camp camp-add" onClick={() => setTao(true)}>
          <Plus size={20} />
          Tạo chiến dịch
        </button>
      )}
    </div>
  );
}
