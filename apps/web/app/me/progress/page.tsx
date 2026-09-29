'use client';

import { useEffect, useState } from 'react';
import type { ProgressEntry } from '@pt/contracts';

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
  const [form, setForm] = useState({ recordedOn: homNayVN(), weightKg: '', bodyFatPct: '', note: '' });
  const [tep, setTep] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function nap() {
    const res = await fetch('/api/proxy/me/progress');
    if (res.ok) setRows((await res.json()) as ProgressEntry[]);
  }
  useEffect(() => {
    void nap();
  }, []);

  /** Lấy URL xem ảnh, hạn rất ngắn nên xin ngay lúc cần chứ không xin trước. */
  async function xemAnh(fileId: string) {
    const res = await fetch(`/api/proxy/files/${fileId}/url`);
    if (!res.ok) return;
    const { url } = (await res.json()) as { url: string };
    setAnh((a) => ({ ...a, [fileId]: url }));
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
          ...(form.weightKg ? { weightKg: Number(form.weightKg) } : {}),
          ...(form.bodyFatPct ? { bodyFatPct: Number(form.bodyFatPct) } : {}),
          ...(form.note ? { note: form.note } : {}),
          ...(photoFileId ? { photoFileId } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Không lưu được');

      setForm({ recordedOn: homNayVN(), weightKg: '', bodyFatPct: '', note: '' });
      setTep(null);
      await nap();
    } catch (err) {
      setLoi(err instanceof Error ? err.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 style={S.h1}>Tiến độ của bạn</h1>
      <p style={S.sub}>Số đo và ảnh chỉ mình bạn và phòng tập xem được.</p>

      <form style={S.form} onSubmit={luu}>
        <div style={S.doi}>
          <label style={S.label}>
            Ngày đo
            <input
              style={S.input} type="date" value={form.recordedOn}
              onChange={(e) => setForm({ ...form, recordedOn: e.target.value })}
            />
          </label>
          <label style={S.label}>
            Cân nặng (kg)
            <input
              style={S.input} inputMode="decimal" placeholder="72.5" value={form.weightKg}
              onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
            />
          </label>
        </div>
        <div style={S.doi}>
          <label style={S.label}>
            Tỷ lệ mỡ (%)
            <input
              style={S.input} inputMode="decimal" placeholder="18.3" value={form.bodyFatPct}
              onChange={(e) => setForm({ ...form, bodyFatPct: e.target.value })}
            />
          </label>
          <label style={S.label}>
            Ảnh (tuỳ chọn)
            <input
              style={S.input} type="file" accept="image/jpeg,image/png,image/webp"
              onChange={(e) => setTep(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>
        <label style={S.label}>
          Ghi chú
          <input
            style={S.input} value={form.note} placeholder="Cảm nhận, chế độ ăn…"
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>
        {loi && <p style={S.loi}>{loi}</p>}
        <button style={S.nut} disabled={busy} type="submit">
          {busy ? 'Đang lưu…' : 'Lưu số đo'}
        </button>
      </form>

      {rows === null && <p style={S.trong}>Đang tải…</p>}
      {rows?.length === 0 && <p style={S.trong}>Chưa có số đo nào.</p>}

      {rows?.map((r) => (
        <article key={r.id} style={S.card}>
          <div style={S.hang}>
            <strong>{r.recordedOn}</strong>
            {r.weightDelta != null && (
              <span style={r.weightDelta <= 0 ? S.giam : S.tang}>
                {r.weightDelta > 0 ? '+' : ''}
                {r.weightDelta} kg
              </span>
            )}
          </div>
          <div style={S.soDo}>
            {r.weightKg != null && <span>{r.weightKg} kg</span>}
            {r.bodyFatPct != null && <span>mỡ {r.bodyFatPct}%</span>}
            {r.muscleKg != null && <span>cơ {r.muscleKg} kg</span>}
          </div>
          {r.note && <span style={S.ghiChu}>{r.note}</span>}
          {r.photoFileId &&
            (anh[r.photoFileId] ? (
              <img src={anh[r.photoFileId]} alt="Ảnh tiến độ" style={S.anh} />
            ) : (
              <button style={S.nutAnh} onClick={() => void xemAnh(r.photoFileId!)}>
                Xem ảnh
              </button>
            ))}
        </article>
      ))}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  h1: { margin: 0, fontSize: 22 },
  sub: { margin: '3px 0 16px', fontSize: 13, color: '#8b93a7' },
  trong: { fontSize: 13, color: '#8b93a7' },
  form: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 16, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: 10,
  },
  doi: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 },
  label: { display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, color: '#b6bdcd' },
  input: {
    padding: '9px 11px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#0f1115', color: '#f2f4f8', fontSize: 14, minWidth: 0,
  },
  nut: {
    padding: '11px 14px', borderRadius: 8, border: 'none', background: '#3b82f6',
    color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  nutAnh: {
    alignSelf: 'flex-start', padding: '6px 12px', borderRadius: 7,
    border: '1px solid #2c3240', background: '#0f1115', color: '#93c5fd',
    fontSize: 12, cursor: 'pointer',
  },
  anh: { width: '100%', borderRadius: 8, marginTop: 4 },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10,
    padding: '12px 14px', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 5,
  },
  hang: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
  soDo: { display: 'flex', gap: 12, fontSize: 13, color: '#b6bdcd' },
  ghiChu: { fontSize: 12, color: '#8b93a7' },
  giam: { fontSize: 13, color: '#4ade80' },
  tang: { fontSize: 13, color: '#fbbf24' },
  loi: { margin: 0, fontSize: 13, color: '#f87171' },
};
