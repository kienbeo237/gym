'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, KeyRound, LoaderCircle, PlugZap, Save, Unlink } from 'lucide-react';
import type { ZaloOaInfo, ZnsTemplateRow } from '@pt/contracts';
import { Badge } from '../../../../components/ui';
import { goiApi, thongBaoLoi } from '../../../../lib/client-api';
import { TRANG_THAI_MAU } from '../../../../lib/labels';

// ---- Khoá ứng dụng ------------------------------------------------------------

/**
 * Secret KHÔNG BAO GIỜ được trả về trình duyệt — kể cả dạng che sao. Ô nhập
 * luôn trống; muốn đổi thì nhập lại cả hai.
 */
export function CredentialsForm({ info }: { info: ZaloOaInfo }) {
  const router = useRouter();
  const [appId, setAppId] = useState(info.appId ?? '');
  const [secretKey, setSecretKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState(false);

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    setXong(false);
    try {
      await goiApi('zalo/oa/credentials', { method: 'PUT', body: { appId, secretKey } });
      setSecretKey('');
      setXong(true);
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  const doiApp = !!info.appId && appId.trim() !== info.appId;

  return (
    <form className="stack" style={{ gap: 14 }} onSubmit={luu}>
      <div className="form-grid">
        <label className="field">
          <span className="field-label">App ID</span>
          <input
            className="input tabular"
            inputMode="numeric"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="VD: 1234567890123456789"
            required
          />
        </label>
        <label className="field">
          <span className="field-label">Secret key</span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={secretKey}
            onChange={(e) => setSecretKey(e.target.value)}
            placeholder={info.hasSecret ? '•••••••• (đã lưu — nhập để thay)' : 'Khoá bí mật của ứng dụng'}
            required
          />
        </label>
      </div>
      {doiApp && (
        <p className="field-hint text-warning">
          Đổi sang ứng dụng khác sẽ xoá phiên kết nối hiện tại — bạn sẽ phải kết nối lại OA.
        </p>
      )}
      {loi && (
        <p className="field-hint text-danger" role="alert">
          {loi}
        </p>
      )}
      <div className="row-start" style={{ gap: 10 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />}
          Lưu khoá ứng dụng
        </button>
        {xong && (
          <span className="small text-success row-start" style={{ gap: 4 }}>
            <Check size={14} /> Đã lưu và mã hoá
          </span>
        )}
      </div>
    </form>
  );
}

// ---- Khoá webhook báo phát ------------------------------------------------------

/** "OA Secret Key" của mục Webhook — khác secret key của ứng dụng ở bước 1. */
export function WebhookForm({ info }: { info: ZaloOaInfo }) {
  const router = useRouter();
  const [khoa, setKhoa] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState('');

  async function luu(secretKey: string | null) {
    setBusy(true);
    setLoi('');
    setXong('');
    try {
      await goiApi('zalo/oa/webhook-secret', { method: 'PUT', body: { secretKey } });
      setKhoa('');
      setXong(secretKey ? 'Đã lưu và mã hoá' : 'Đã tắt nhận báo phát');
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ gap: 12 }} onSubmit={(e) => { e.preventDefault(); void luu(khoa.trim()); }}>
      <label className="field" style={{ maxWidth: 480 }}>
        <span className="field-label">OA Secret Key (mục Webhook)</span>
        <input className="input" type="password" autoComplete="off" required minLength={8} value={khoa}
          onChange={(e) => setKhoa(e.target.value)} disabled={!info.hasSecret}
          placeholder={info.hasWebhookSecret ? '•••••••• (đã lưu — nhập để thay)' : 'Dùng để kiểm chữ ký sự kiện Zalo gửi tới'} />
        {!info.hasSecret && <span className="field-hint">Lưu khoá ứng dụng ở bước 1 trước.</span>}
      </label>
      {loi && <p className="field-hint text-danger" role="alert">{loi}</p>}
      <div className="row-start" style={{ gap: 10, flexWrap: 'wrap' }}>
        <button className="btn btn-secondary" type="submit" disabled={busy || !info.hasSecret}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <KeyRound size={16} />} Lưu khoá webhook
        </button>
        {info.hasWebhookSecret && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void luu(null)}>
            <Unlink size={16} /> Tắt báo phát
          </button>
        )}
        {xong && (
          <span className="small text-success row-start" style={{ gap: 4 }}>
            <Check size={14} /> {xong}
          </span>
        )}
      </div>
    </form>
  );
}

// ---- Kết nối / ngắt ----------------------------------------------------------

export function ConnectButtons({ info }: { info: ZaloOaInfo }) {
  const router = useRouter();
  const [busy, setBusy] = useState<'' | 'connect' | 'disconnect'>('');
  const [loi, setLoi] = useState('');

  async function ketNoi() {
    setBusy('connect');
    setLoi('');
    try {
      const { url } = await goiApi<{ url: string }>('zalo/oa/connect', { method: 'POST' });
      // Rời trang sang Zalo để chủ OA cấp quyền; Zalo sẽ quay về /settings/zalo/callback.
      window.location.href = url;
    } catch (e) {
      setLoi(thongBaoLoi(e));
      setBusy('');
    }
  }

  async function ngat() {
    if (!confirm('Ngắt kết nối Zalo OA? Mọi tin Zalo sẽ ngừng gửi cho tới khi kết nối lại.')) return;
    setBusy('disconnect');
    setLoi('');
    try {
      await goiApi('zalo/oa', { method: 'DELETE' });
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy('');
    }
  }

  const daKetNoi = info.status === 'CONNECTED';

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className={daKetNoi ? 'btn btn-secondary' : 'btn btn-primary'}
          onClick={ketNoi}
          disabled={!!busy || !info.hasSecret}
          title={info.hasSecret ? undefined : 'Lưu App ID và secret key trước'}
        >
          {busy === 'connect' ? <LoaderCircle size={16} className="spin" /> : <PlugZap size={16} />}
          {info.status === 'DISCONNECTED' ? 'Kết nối Zalo OA' : 'Kết nối lại'}
        </button>
        {info.status !== 'DISCONNECTED' && (
          <button type="button" className="btn btn-ghost" onClick={ngat} disabled={!!busy}>
            {busy === 'disconnect' ? <LoaderCircle size={16} className="spin" /> : <Unlink size={16} />}
            Ngắt kết nối
          </button>
        )}
      </div>
      {loi && (
        <p className="field-hint text-danger" role="alert">
          {loi}
        </p>
      )}
    </div>
  );
}

export function CopyText({ text }: { text: string }) {
  const [daChep, setDaChep] = useState(false);
  return (
    <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
      <code className="small" style={{ wordBreak: 'break-all' }}>
        {text}
      </code>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={async () => {
          await navigator.clipboard.writeText(text).catch(() => {});
          setDaChep(true);
          setTimeout(() => setDaChep(false), 1500);
        }}
      >
        {daChep ? <Check size={14} /> : <Copy size={14} />}
        {daChep ? 'Đã chép' : 'Chép'}
      </button>
    </div>
  );
}

// ---- Mẫu tin ZNS -------------------------------------------------------------

function DongMau({ row }: { row: ZnsTemplateRow }) {
  const router = useRouter();
  const [tplId, setTplId] = useState(row.providerTplId ?? '');
  const [status, setStatus] = useState(row.status === 'NOT_SET' ? 'PENDING' : row.status);
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  const doi = tplId.trim() !== (row.providerTplId ?? '') || (row.status !== 'NOT_SET' && status !== row.status) ||
    (row.status === 'NOT_SET' && !!tplId.trim());

  async function luu() {
    setBusy(true);
    setLoi('');
    try {
      await goiApi(`zalo/templates/${row.code}`, {
        method: 'PUT',
        body: { providerTplId: tplId.trim() || null, status },
      });
      router.refresh();
    } catch (e) {
      setLoi(thongBaoLoi(e));
    } finally {
      setBusy(false);
    }
  }

  const nhan = TRANG_THAI_MAU[row.status] ?? { text: row.status, tone: 'neutral' as const };

  return (
    <tr>
      <td style={{ minWidth: 240 }}>
        <div className="cell-main row-start" style={{ gap: 8 }}>
          {row.name}
          <Badge tone={nhan.tone}>{nhan.text}</Badge>
        </div>
        <div className="cell-sub" style={{ whiteSpace: 'normal', maxWidth: 420 }}>
          {row.description}
        </div>
        <div className="cell-sub" style={{ whiteSpace: 'normal', maxWidth: 420 }}>
          Tham số:{' '}
          {row.params.map((p, i) => (
            <span key={p.key} title={`${p.label} — VD: ${p.example}`}>
              {i > 0 && ', '}
              <code>{p.key}</code>
            </span>
          ))}
        </div>
      </td>
      <td style={{ minWidth: 150 }}>
        <input
          className="input tabular"
          value={tplId}
          onChange={(e) => setTplId(e.target.value)}
          placeholder="Mã template"
          aria-label={`Mã template Zalo cho ${row.name}`}
        />
      </td>
      <td style={{ minWidth: 150 }}>
        <select
          className="input"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label={`Trạng thái duyệt của ${row.name}`}
        >
          <option value="PENDING">Chờ Zalo duyệt</option>
          <option value="APPROVED">Đã duyệt</option>
          <option value="REJECTED">Bị từ chối</option>
          <option value="DISABLED">Tạm tắt</option>
        </select>
        {loi && <div className="field-hint text-danger mt-4">{loi}</div>}
      </td>
      <td className="num">
        <button type="button" className="btn btn-secondary btn-sm" onClick={luu} disabled={busy || !doi}>
          {busy ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}
          Lưu
        </button>
      </td>
    </tr>
  );
}

export function TemplateTable({ rows }: { rows: ZnsTemplateRow[] }) {
  return (
    <div className="table-wrap">
      <table className="table table-flush">
        <thead>
          <tr>
            <th>Mẫu tin</th>
            <th>Mã template Zalo</th>
            <th>Trạng thái</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <DongMau key={r.code} row={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
