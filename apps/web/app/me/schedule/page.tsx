import type { BookingItem } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const TZ = 'Asia/Ho_Chi_Minh';

const NHAN: Record<BookingItem['status'], { text: string; mau: string }> = {
  BOOKED: { text: 'Sắp tới', mau: '#93c5fd' },
  CHECKED_IN: { text: 'Đã điểm danh', mau: '#4ade80' },
  COMPLETED: { text: 'Đã tập xong', mau: '#4ade80' },
  NO_SHOW: { text: 'Vắng mặt', mau: '#f87171' },
  CANCELLED_BY_MEMBER: { text: 'Bạn đã huỷ', mau: '#8b93a7' },
  CANCELLED_BY_PT: { text: 'Huấn luyện viên huỷ', mau: '#8b93a7' },
  CANCELLED_BY_STAFF: { text: 'Phòng tập huỷ', mau: '#8b93a7' },
};

const dich = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export default async function MeSchedule() {
  const session = await requireSession();
  const homNay = new Date().toLocaleDateString('en-CA', { timeZone: TZ });

  // Endpoint này tự ép phạm vi về chính người gọi khi họ chỉ là hội viên —
  // không truyền memberId lên, và truyền cũng vô ích.
  const rows = await apiFetch<BookingItem[]>(
    `/bookings?from=${dich(homNay, -30)}&to=${dich(homNay, 60)}`,
    session,
  );

  const sapToi = rows.filter((b) => b.startsAt >= new Date().toISOString() && b.status === 'BOOKED');
  const daQua = rows.filter((b) => !sapToi.includes(b)).reverse();

  const The = ({ b }: { b: BookingItem }) => {
    const n = NHAN[b.status];
    return (
      <article style={{ ...S.card, borderLeft: `3px solid ${n.mau}` }}>
        <div style={S.hang}>
          <strong style={S.gio}>
            {new Date(b.startsAt).toLocaleString('vi-VN', {
              timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit',
            })}
          </strong>
          <span style={{ ...S.nhan, color: n.mau }}>{n.text}</span>
        </div>
        <span style={S.phu}>Huấn luyện viên: {b.trainerName}</span>
        {/* Buổi đã huỷ mà VẪN bị trừ là điều hội viên sẽ thắc mắc — nói ra
            ngay trên thẻ thay vì để họ tự đối chiếu số buổi. */}
        {b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED' && (
          <span style={S.truBuoi}>Buổi này đã bị trừ khỏi gói</span>
        )}
        {b.cancelReason && <span style={S.lyDo}>Lý do: {b.cancelReason}</span>}
      </article>
    );
  };

  return (
    <>
      <h1 style={S.h1}>Lịch tập của bạn</h1>

      <h2 style={S.h2}>Sắp tới ({sapToi.length})</h2>
      {sapToi.length === 0 && <p style={S.trong}>Bạn chưa có buổi tập nào sắp tới.</p>}
      {sapToi.map((b) => <The key={b.id} b={b} />)}

      <h2 style={S.h2}>Đã qua</h2>
      {daQua.length === 0 && <p style={S.trong}>Chưa có buổi tập nào.</p>}
      {daQua.slice(0, 30).map((b) => <The key={b.id} b={b} />)}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  h1: { margin: '0 0 4px', fontSize: 22 },
  h2: { margin: '20px 0 10px', fontSize: 13, color: '#b6bdcd' },
  trong: { fontSize: 13, color: '#8b93a7' },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10,
    padding: '12px 14px', marginBottom: 8, display: 'flex', flexDirection: 'column', gap: 3,
  },
  hang: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' },
  gio: { fontSize: 14 },
  nhan: { fontSize: 11, whiteSpace: 'nowrap' },
  phu: { fontSize: 12, color: '#8b93a7' },
  truBuoi: { fontSize: 11, color: '#fbbf24', marginTop: 3 },
  lyDo: { fontSize: 11, color: '#8b93a7', fontStyle: 'italic' },
};
