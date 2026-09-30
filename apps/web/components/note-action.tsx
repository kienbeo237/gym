'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, LoaderCircle, type LucideIcon } from 'lucide-react';
import { goiApi, thongBaoLoi } from '../lib/client-api';

export type NoteActionDef = {
  key: string;
  label: string;
  icon?: LucideIcon;
  /** Đường dẫn API (qua /api/proxy), luôn POST, body `{ note }`. */
  path: string;
  desc: string;
  noteLabel?: string;
  placeholder?: string;
  noteRequired?: boolean;
  submitLabel: string;
  doneText: string;
  primary?: boolean;
};

/**
 * Một hàng nút thao tác, mỗi nút mở một ô ghi chú rồi gửi. Dùng cho các thao
 * tác "duyệt / từ chối / đánh dấu đã xử lý" — cùng một hình, khác đường dẫn.
 * Quy tắc nằm ở API; ở đây chỉ hiện câu lỗi API trả về.
 */
export function NoteActions({ actions }: { actions: NoteActionDef[] }) {
  const router = useRouter();
  const [mo, setMo] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');
  const [xong, setXong] = useState('');
  const a = actions.find((x) => x.key === mo);

  async function gui(e: React.FormEvent) {
    e.preventDefault();
    if (!a) return;
    setBusy(true);
    setLoi('');
    try {
      await goiApi(a.path, { method: 'POST', body: note.trim() ? { note: note.trim() } : {} });
      setXong(a.doneText);
      setMo(null);
      router.refresh();
    } catch (err) {
      setLoi(thongBaoLoi(err));
    } finally {
      setBusy(false);
    }
  }

  if (xong) {
    return (
      <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}>
        <CircleCheck size={15} /> {xong}
      </p>
    );
  }

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
        {actions.map((x) => {
          const Icon = x.icon;
          return (
            <button
              key={x.key}
              type="button"
              className={x.primary ? (mo === x.key ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm') : 'btn btn-ghost btn-sm'}
              aria-pressed={mo === x.key}
              onClick={() => {
                setMo((o) => (o === x.key ? null : x.key));
                setNote('');
                setLoi('');
              }}
            >
              {Icon && <Icon size={14} />} {x.label}
            </button>
          );
        })}
      </div>
      {a && (
        <form className="panel stack" style={{ gap: 12 }} onSubmit={gui}>
          <p className="small muted" style={{ margin: 0 }}>
            {a.desc}
          </p>
          <label className="field">
            <span className="field-label">
              {a.noteLabel ?? 'Ghi chú'}
              {!a.noteRequired && <span className="faint"> (không bắt buộc)</span>}
            </span>
            <input
              className="input"
              value={note}
              required={a.noteRequired}
              minLength={a.noteRequired ? 3 : undefined}
              maxLength={500}
              placeholder={a.placeholder}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {loi && (
            <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
              {loi}
            </p>
          )}
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy}>
              {busy && <LoaderCircle size={14} className="spin" />}
              {a.submitLabel}
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setMo(null)} disabled={busy}>
              Thôi
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
