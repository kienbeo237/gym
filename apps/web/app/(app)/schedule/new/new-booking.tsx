'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarCheck, LoaderCircle, PackageX, Search, X } from 'lucide-react';
import type { MemberDetail, MemberSummary, Paged } from '@pt/contracts';
import { SlotPicker, type Slot } from '../../../../components/slot-picker';
import { Alert, Avatar, Card } from '../../../../components/ui';
import { goiApi } from '../../../../lib/client-api';
import { ngayGioVN, ngayISO } from '../../../../lib/format';
import { useAction } from '../../../../lib/use-action';

/**
 * Đặt lịch cho hội viên: chọn người → chọn hợp đồng → chọn khung trống.
 * Chỉ hợp đồng ĐANG DÙNG mới đặt được (API cũng chặn) — hiện hết để lễ tân
 * thấy vì sao một gói không bấm được.
 */
export function NewBooking({ initial, initialPackageId }: { initial: MemberDetail | null; initialPackageId?: string }) {
  const router = useRouter();
  const [member, setMember] = useState<MemberDetail | null>(initial);
  const [q, setQ] = useState('');
  const [ketQua, setKetQua] = useState<MemberSummary[]>([]);
  const [dangTim, setDangTim] = useState(false);
  const dungDuoc = member?.packages.filter((p) => p.status === 'ACTIVE') ?? [];
  const [goi, setGoi] = useState<string | null>(
    initialPackageId && dungDuoc.some((p) => p.id === initialPackageId)
      ? initialPackageId
      : dungDuoc.length === 1
        ? dungDuoc[0]!.id
        : null,
  );
  const [dur, setDur] = useState(60);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [note, setNote] = useState('');
  const { busy, loi, chay } = useAction();

  useEffect(() => {
    if (member || q.trim().length < 2) {
      setKetQua([]);
      return;
    }
    let huy = false;
    setDangTim(true);
    const t = setTimeout(() => {
      goiApi<Paged<MemberSummary>>(`members?size=8&q=${encodeURIComponent(q.trim())}`)
        .then((d) => !huy && setKetQua(d.items))
        .catch(() => !huy && setKetQua([]))
        .finally(() => !huy && setDangTim(false));
    }, 250);
    return () => {
      huy = true;
      clearTimeout(t);
    };
  }, [q, member]);

  async function chonNguoi(id: string) {
    const d = await chay(() => goiApi<MemberDetail>(`members/${id}`));
    if (!d) return;
    setMember(d);
    const act = d.packages.filter((p) => p.status === 'ACTIVE');
    setGoi(act.length === 1 ? act[0]!.id : null);
    setSlot(null);
  }

  async function dat() {
    if (!goi || !slot) return;
    const r = await chay(() =>
      goiApi<{ id: string }>('bookings', {
        method: 'POST',
        body: { memberPackageId: goi, startsAt: slot.startsAt, durationMinutes: dur, ...(note.trim() ? { note: note.trim() } : {}) },
      }),
    );
    if (r) router.push(`/schedule/${r.id}`);
  }

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Card title="1. Hội viên">
        {member ? (
          <div className="row" style={{ gap: 12 }}>
            <div className="cell-person">
              <Avatar name={member.fullName} />
              <div>
                <div className="cell-main">{member.fullName}</div>
                <div className="cell-sub">
                  {member.code} · {member.phone}
                </div>
              </div>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setMember(null); setGoi(null); setSlot(null); }}>
              <X size={14} /> Đổi người
            </button>
          </div>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <label className="input-wrap">
              <span className="sr-only">Tìm hội viên</span>
              <Search size={17} />
              <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Gõ tên, số điện thoại hoặc mã hội viên" />
            </label>
            {dangTim && <LoaderCircle size={16} className="spin faint" />}
            {ketQua.length > 0 && (
              <div className="stack" style={{ gap: 4 }}>
                {ketQua.map((m) => (
                  <button key={m.id} type="button" className="btn btn-ghost" style={{ justifyContent: 'flex-start', height: 'auto', padding: '8px 10px' }}
                    onClick={() => void chonNguoi(m.id)}>
                    <span className="cell-person">
                      <Avatar name={m.fullName} size="sm" />
                      <span style={{ textAlign: 'left' }}>
                        <span className="cell-main">{m.fullName}</span>
                        <span className="cell-sub" style={{ display: 'block' }}>
                          {m.code} · {m.phone} · {m.activePackages > 0 ? `${m.sessionsRemaining} buổi còn lại` : 'không có gói'}
                        </span>
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!dangTim && q.trim().length >= 2 && ketQua.length === 0 && (
              <p className="small muted" style={{ margin: 0 }}>Không tìm thấy hội viên nào.</p>
            )}
          </div>
        )}
      </Card>

      {member && (
        <Card title="2. Hợp đồng">
          {member.packages.length === 0 || dungDuoc.length === 0 ? (
            <Alert tone="warning" icon={PackageX}>
              <span>
                Hội viên không có hợp đồng nào đang dùng.{' '}
                <Link className="link" href={`/members/${member.id}/sell`}>Bán gói mới</Link>
              </span>
            </Alert>
          ) : (
            <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label="Chọn hợp đồng">
              {member.packages.map((p) => {
                const dung = p.status === 'ACTIVE';
                const conDat = p.sessionsRemaining - p.sessionsBooked;
                return (
                  <label key={p.id} className="panel row-start" style={{ gap: 10, cursor: dung ? 'pointer' : 'not-allowed', opacity: dung ? 1 : 0.55 }}>
                    <input type="radio" name="goi" disabled={!dung} checked={goi === p.id}
                      onChange={() => { setGoi(p.id); setSlot(null); }} />
                    <span style={{ minWidth: 0 }}>
                      <span className="strong">{p.name}</span> <span className="faint">({p.code})</span>
                      <span className="cell-sub" style={{ display: 'block' }}>
                        {dung
                          ? `Còn ${p.sessionsRemaining} buổi · đã đặt ${p.sessionsBooked} · đặt thêm được ${Math.max(0, conDat)} · HLV ${p.trainerName ?? 'chưa gắn'} · hạn ${ngayISO(p.expiresOn)}`
                          : 'Không đặt được — hợp đồng không ở trạng thái đang dùng'}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {member && goi && (
        <Card title="3. Giờ tập">
          <div className="stack" style={{ gap: 16 }}>
            <SlotPicker memberPackageId={goi} value={slot} onChange={setSlot} duration={dur} onDurationChange={setDur} />
            <label className="field">
              <span className="field-label">Ghi chú <span className="faint">(không bắt buộc)</span></span>
              <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
            </label>
            {loi && <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>{loi}</p>}
            <div>
              <button type="button" className="btn btn-primary" disabled={!slot || busy} onClick={dat}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <CalendarCheck size={16} />}
                {slot ? `Đặt ${ngayGioVN(slot.startsAt)}` : 'Chọn một khung giờ'}
              </button>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
