'use client';

import { useEffect, useState } from 'react';
import { ChartLine, CircleAlert, Eye, LoaderCircle, Lock, Plus, TrendingDown, TrendingUp } from 'lucide-react';
import type { ProgressEntry } from '@pt/contracts';
import { EmptyState } from '../../../components/ui';
import { ngayISO } from '../../../lib/format';

const homNayVN = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

/**
 * Nhật ký tiến độ — dữ liệu nhạy cảm nhất của hội viên.
 *
 * Ảnh đi THẲNG từ trình duyệt lên S3 qua presigned URL; máy chủ chỉ ký. URL tải
 * về sống 60 giây (FILE_RULES.PROGRESS_PHOTO) nên không nằm lại trong lịch sử
 * trình duyệt hay bộ nhớ đệm nào đủ lâu để thành vấn đề.
 *
 * Backend ÉP `ownerId` về chính người gọi, nên kể cả khi trang này gửi sai thì
 * ảnh vẫn thuộc đúng chủ.
 */
export default function MeProgress() {
  const [rows, setRows] = useState<ProgressEntry[] | null>(null);
  const [anh, setAnh] = useState<Record<string, string>>({});
  const [dangXem, setDangXem] = useState<string | null>(null);
  const [form, setForm] = useState({ recordedOn: homNayVN(), weightKg: '', bodyFatPct: '', note: '' });
  const [tep, setTep] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function nap() {
    const res = await fetch('/api/proxy/me/progress');
    if (res.ok) setRows((await res.json()) as ProgressEntry[]);
    else setRows([]);
  }
  useEffect(() => {
    void nap();
  }, []);

  /** Lấy URL xem ảnh, hạn rất ngắn nên xin ngay lúc cần chứ không xin trước. */
  async function xemAnh(fileId: string) {
    setDangXem(fileId);
    try {
      const res = await fetch(`/api/proxy/files/${fileId}/url`);
      if (!res.ok) return;
      const { url } = (await res.json()) as { url: string };
      setAnh((a) => ({ ...a, [fileId]: url }));
    } finally {
      setDangXem(null);
    }
  }

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoi('');
    try {
      let photoFileId: string | undefined;

      if (tep) {
        // Ba bước: xin URL -> PUT thẳng lên S3 -> xác nhận. Máy chủ đọc lại kích
        // thước thật từ S3 ở bước ba, không tin con số khai ở bước một.
        const xin = await fetch('/api/proxy/files/upload-url', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ownerType: 'PROGRESS_PHOTO',
            fileName: tep.name,
            mime: tep.type || 'image/jpeg',
            sizeBytes: tep.size,
          }),
        });
        const up = await xin.json();
        if (!xin.ok) throw new Error(up.message ?? 'Không tải được ảnh');

        const put = await fetch(up.uploadUrl, {
          method: 'PUT',
          body: tep,
          headers: { 'content-type': tep.type || 'image/jpeg' },
        });
        if (!put.ok) throw new Error('Tải ảnh lên không thành công');

        const xn = await fetch(`/api/proxy/files/${up.fileId}/confirm`, { method: 'POST' });
        if (!xn.ok) throw new Error('Xác nhận ảnh không thành công');
        photoFileId = up.fileId;
      }

      const res = await fetch('/api/proxy/me/progress', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          recordedOn: form.recordedOn,
          ...(form.weightKg ? { weightKg: Number(form.weightKg.replace(',', '.')) } : {}),
          ...(form.bodyFatPct ? { bodyFatPct: Number(form.bodyFatPct.replace(',', '.')) } : {}),
          ...(form.note ? { note: form.note } : {}),
          ...(photoFileId ? { photoFileId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Không lưu được');

      setForm({ recordedOn: homNayVN(), weightKg: '', bodyFatPct: '', note: '' });
      setTep(null);
      setInputKey((k) => k + 1);
      await nap();
    } catch (err) {
      setLoi(err instanceof Error ? err.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="m-title">Tiến độ của bạn</h1>
      <p className="m-sub row-start" style={{ gap: 6 }}>
        <Lock size={13} /> Số đo và ảnh chỉ mình bạn và phòng tập xem được.
      </p>

      <form className="card list-card mt-16" style={{ gap: 14 }} onSubmit={luu}>
        <div className="card-title">Ghi số đo mới</div>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">Ngày đo</span>
            <input
              className="input"
              type="date"
              value={form.recordedOn}
              max={homNayVN()}
              onChange={(e) => setForm({ ...form, recordedOn: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Cân nặng (kg)</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="72.5"
              value={form.weightKg}
              onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Tỷ lệ mỡ (%)</span>
            <input
              className="input"
              inputMode="decimal"
              placeholder="18.3"
              value={form.bodyFatPct}
              onChange={(e) => setForm({ ...form, bodyFatPct: e.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">Ảnh (tuỳ chọn)</span>
            <input
              key={inputKey}
              className="input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setTep(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <label className="field">
          <span className="field-label">Ghi chú</span>
          <input
            className="input"
            value={form.note}
            placeholder="Cảm nhận, chế độ ăn…"
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
        {loi && (
          <div className="alert" data-tone="danger" role="alert">
            <CircleAlert size={17} />
            <div className="alert-body">{loi}</div>
          </div>
        )}
        <button className="btn btn-primary btn-lg btn-block" disabled={busy} type="submit">
          {busy ? <LoaderCircle size={18} className="spin" /> : <Plus size={18} />}
          {busy ? 'Đang lưu…' : 'Lưu số đo'}
        </button>
      </form>

      <h2 className="m-section">Nhật ký</h2>

      {rows === null && (
        <div className="stack">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 84, borderRadius: 14 }} />
          ))}
        </div>
      )}
      {rows?.length === 0 && (
        <div className="card">
          <EmptyState icon={ChartLine} title="Chưa có số đo nào" text="Ghi lần đo đầu tiên để theo dõi tiến bộ theo thời gian." />
        </div>
      )}

      <div className="stack">
        {rows?.map((r) => (
          <article key={r.id} className="card list-card">
            <div className="row">
              <strong>{ngayISO(r.recordedOn)}</strong>
              {r.weightDelta != null && r.weightDelta !== 0 && (
                <span
                  className="badge"
                  data-tone={r.weightDelta < 0 ? 'success' : 'warning'}
                >
                  {r.weightDelta < 0 ? <TrendingDown size={13} /> : <TrendingUp size={13} />}
                  {r.weightDelta > 0 ? '+' : ''}
                  {r.weightDelta} kg
                </span>
              )}
            </div>
            <div className="row-start" style={{ gap: 20, flexWrap: 'wrap' }}>
              {r.weightKg != null && <Chi so={r.weightKg} donVi="kg" nhan="Cân nặng" />}
              {r.bodyFatPct != null && <Chi so={r.bodyFatPct} donVi="%" nhan="Tỷ lệ mỡ" />}
              {r.muscleKg != null && <Chi so={r.muscleKg} donVi="kg" nhan="Khối cơ" />}
            </div>
            {r.note && <p className="small muted">{r.note}</p>}
            {r.photoFileId &&
              (anh[r.photoFileId] ? (
                <img src={anh[r.photoFileId]} alt="Ảnh tiến độ" style={{ width: '100%', borderRadius: 10 }} />
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  disabled={dangXem === r.photoFileId}
                  onClick={() => void xemAnh(r.photoFileId!)}
                >
                  {dangXem === r.photoFileId ? <LoaderCircle size={15} className="spin" /> : <Eye size={15} />}
                  Xem ảnh
                </button>
              ))}
          </article>
        ))}
      </div>
    </>
  );
}

function Chi({ so, donVi, nhan }: { so: number; donVi: string; nhan: string }) {
  return (
    <div>
      <div className="cell-sub">{nhan}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }} className="num">
        {so}
        <span className="muted" style={{ fontSize: 13, fontWeight: 600, marginLeft: 3 }}>
          {donVi}
        </span>
      </div>
    </div>
  );
}
