import Link from 'next/link';
import { CalendarDays, CalendarPlus, CalendarX, CircleCheck, UserRound } from 'lucide-react';
import type { BookingItem } from '@pt/contracts';
import { BookingActions } from '../../../components/booking-actions';
import { Alert, Badge, EmptyState, type Tone } from '../../../components/ui';
import { TZ, dichNgay, gioVN, ngayVN } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

const NHAN: Record<BookingItem['status'], { text: string; tone: Tone }> = {
  BOOKED: { text: 'Sắp tới', tone: 'info' },
  CHECKED_IN: { text: 'Đã điểm danh', tone: 'success' },
  COMPLETED: { text: 'Đã tập xong', tone: 'success' },
  NO_SHOW: { text: 'Vắng mặt', tone: 'danger' },
  CANCELLED_BY_MEMBER: { text: 'Bạn đã huỷ', tone: 'neutral' },
  CANCELLED_BY_PT: { text: 'HLV huỷ', tone: 'neutral' },
  CANCELLED_BY_STAFF: { text: 'Phòng tập huỷ', tone: 'neutral' },
};

function The({ b, sapToi }: { b: BookingItem; sapToi?: boolean }) {
  const n = NHAN[b.status];
  const d = new Date(b.startsAt);
  return (
    <article className="card list-card">
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="row-start" style={{ alignItems: 'flex-start' }}>
          <div
            className="icon-tile"
            data-tone={n.tone === 'info' ? undefined : n.tone}
            style={{ flexDirection: 'column', gap: 0, lineHeight: 1.05 }}
          >
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              {d.toLocaleDateString('vi-VN', { timeZone: TZ, weekday: 'short' })}
            </span>
            <span style={{ fontSize: 16, fontWeight: 800 }}>
              {d.toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit' })}
            </span>
          </div>
          <div>
            <div className="strong">
              {gioVN(b.startsAt)} – {gioVN(b.endsAt)}
              <span className="muted" style={{ fontWeight: 400 }}>
                {' · '}
                {d.toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit' })}
              </span>
            </div>
            <div className="meta-line mt-4">
              <span>
                <UserRound size={13} /> {b.trainerName}
              </span>
            </div>
          </div>
        </div>
        <Badge tone={n.tone}>{n.text}</Badge>
      </div>
      {/* Buổi đã huỷ mà VẪN bị trừ là điều hội viên sẽ thắc mắc — nói ra
          ngay trên thẻ thay vì để họ tự đối chiếu số buổi. */}
      {b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED' && (
        <span className="small text-warning strong">Buổi này đã bị trừ khỏi gói</span>
      )}
      {b.cancelReason && <span className="small muted">Lý do: {b.cancelReason}</span>}
      {sapToi && <BookingActions booking={b} vai="MEMBER" />}
    </article>
  );
}

export default async function MeSchedule({ searchParams }: { searchParams: Promise<{ booked?: string }> }) {
  const session = await requireSession();
  const { booked } = await searchParams;
  const homNay = ngayVN();

  // Endpoint này tự ép phạm vi về chính người gọi khi họ chỉ là hội viên —
  // không truyền memberId lên, và truyền cũng vô ích.
  const rows = await apiFetch<BookingItem[]>(
    `/bookings?from=${dichNgay(homNay, -30)}&to=${dichNgay(homNay, 60)}`,
    session,
  );

  const bayGio = new Date().toISOString();
  const sapToi = rows
    .filter((b) => b.startsAt >= bayGio && b.status === 'BOOKED')
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const daQua = rows
    .filter((b) => !sapToi.includes(b))
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));

  return (
    <>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="m-title">Lịch tập của bạn</h1>
          <p className="m-sub">30 ngày trước đến 60 ngày tới</p>
        </div>
        <Link href="/me/book" className="btn btn-primary btn-sm">
          <CalendarPlus size={15} /> Đặt lịch
        </Link>
      </div>

      {booked === '1' && (
        <div className="mt-16">
          <Alert tone="success" icon={CircleCheck}>
            <span>Đã đặt lịch. HLV nhận được thông báo; bạn sẽ được nhắc trước giờ tập.</span>
          </Alert>
        </div>
      )}

      <h2 className="m-section">
        Sắp tới <Badge tone="primary">{sapToi.length}</Badge>
      </h2>
      {sapToi.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={CalendarDays}
            title="Chưa có buổi sắp tới"
            text="Chọn giờ trống của huấn luyện viên để đặt buổi tiếp theo."
            action={
              <Link href="/me/book" className="btn btn-primary btn-sm">
                <CalendarPlus size={15} /> Đặt lịch
              </Link>
            }
          />
        </div>
      ) : (
        <div className="stack">
          {sapToi.map((b) => (
            <The key={b.id} b={b} sapToi />
          ))}
        </div>
      )}

      <h2 className="m-section">Đã qua</h2>
      {daQua.length === 0 ? (
        <div className="card">
          <EmptyState icon={CalendarX} title="Chưa có buổi tập nào" />
        </div>
      ) : (
        <div className="stack">
          {daQua.slice(0, 30).map((b) => (
            <The key={b.id} b={b} />
          ))}
        </div>
      )}
    </>
  );
}
