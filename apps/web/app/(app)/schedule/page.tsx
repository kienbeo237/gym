import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarPlus, ChevronLeft, ChevronRight, QrCode } from 'lucide-react';
import type { BookingItem } from '@pt/contracts';
import { Badge, PageHeader } from '../../../components/ui';
import { TZ, dichNgay, gioVN, ngayISO, ngayVN } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Lịch tập' };

const THU = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];

type Mau = 'info' | 'success' | 'danger' | 'neutral';

const NHAN: Record<BookingItem['status'], { text: string; mau: Mau }> = {
  BOOKED: { text: 'Chờ tập', mau: 'info' },
  CHECKED_IN: { text: 'Đã điểm danh', mau: 'success' },
  COMPLETED: { text: 'Đã tập xong', mau: 'success' },
  NO_SHOW: { text: 'Vắng mặt', mau: 'danger' },
  CANCELLED_BY_MEMBER: { text: 'Hội viên huỷ', mau: 'neutral' },
  CANCELLED_BY_PT: { text: 'HLV huỷ', mau: 'neutral' },
  CANCELLED_BY_STAFF: { text: 'Phòng tập huỷ', mau: 'neutral' },
};

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;

  // Tuần bắt đầu từ thứ hai. Mốc "hôm nay" tính theo giờ Việt Nam, không theo
  // giờ máy chủ — máy chủ đặt ở UTC thì sau 17h giờ VN đã sang ngày mới.
  const homNay = ngayVN();
  const thuCuaHomNay = new Date(`${homNay}T00:00:00Z`).getUTCDay();
  const dauTuanMacDinh = dichNgay(homNay, thuCuaHomNay === 0 ? -6 : 1 - thuCuaHomNay);
  const from = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : dauTuanMacDinh;
  const to = dichNgay(from, 6);

  const bookings = await apiFetch<BookingItem[]>(`/bookings?from=${from}&to=${to}`, session);

  const ngay = Array.from({ length: 7 }, (_, i) => dichNgay(from, i));
  const theoNgay = new Map<string, BookingItem[]>(ngay.map((d) => [d, []]));
  for (const b of bookings) theoNgay.get(ngayVN(b.startsAt))?.push(b);
  for (const list of theoNgay.values()) list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const daTap = bookings.filter((b) => b.status === 'CHECKED_IN' || b.status === 'COMPLETED').length;
  const conCho = bookings.filter((b) => b.status === 'BOOKED').length;
  const vangHuy = bookings.filter((b) => b.status.startsWith('CANCELLED') || b.status === 'NO_SHOW').length;

  const laTuanNay = from === dauTuanMacDinh;
  const thangNam = new Date(`${from}T00:00:00Z`).toLocaleDateString('vi-VN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <>
      <PageHeader
        title="Lịch tập"
        sub={
          <>
            {ngayISO(from)} – {ngayISO(to)} · <span className="num">{bookings.length}</span> buổi · {thangNam}
          </>
        }
        actions={
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            <div className="btn-group">
              <Link href={`/schedule?from=${dichNgay(from, -7)}`} aria-label="Tuần trước">
                <ChevronLeft size={16} />
                <span className="hide-sm">Tuần trước</span>
              </Link>
              <Link href="/schedule" aria-current={laTuanNay ? 'page' : undefined} style={laTuanNay ? { color: 'var(--primary-text)' } : undefined}>
                Tuần này
              </Link>
              <Link href={`/schedule?from=${dichNgay(from, 7)}`} aria-label="Tuần sau">
                <span className="hide-sm">Tuần sau</span>
                <ChevronRight size={16} />
              </Link>
            </div>
            <Link href="/schedule/new" className="btn btn-primary">
              <CalendarPlus size={16} /> Đặt lịch
            </Link>
          </div>
        }
      />

      <div className="legend mb-16">
        <span className="legend-item">
          <span className="legend-dot" style={{ background: 'var(--success)' }} />
          <b>{daTap}</b> đã tập
        </span>
        <span className="legend-item">
          <span className="legend-dot" style={{ background: 'var(--info)' }} />
          <b>{conCho}</b> chờ tập
        </span>
        <span className="legend-item">
          <span className="legend-dot" style={{ background: 'var(--danger)' }} />
          <b>{vangHuy}</b> vắng / huỷ
        </span>
      </div>

      <div className="week">
        {ngay.map((d) => {
          const items = theoNgay.get(d) ?? [];
          const laHomNay = d === homNay;
          const thu = new Date(`${d}T00:00:00Z`).getUTCDay();
          return (
            <section key={d} className="day" data-today={laHomNay} aria-label={`${THU[thu]} ${ngayISO(d)}`}>
              <header className="day-head">
                <span className="day-name">{laHomNay ? 'Hôm nay' : THU[thu]}</span>
                <span className="day-date">
                  {d.slice(8)}/{d.slice(5, 7)}
                </span>
              </header>
              {items.length === 0 && <p className="day-empty">Trống</p>}
              {items.map((b) => {
                const n = NHAN[b.status];
                const noiDung = (
                  <>
                    <span className="event-time">
                      {gioVN(b.startsAt)} – {gioVN(b.endsAt)}
                    </span>
                    <span className="event-title">{b.memberName}</span>
                    <span className="event-sub">{b.trainerName}</span>
                    <span className="event-tags">
                      <Badge tone={n.mau}>{n.text}</Badge>
                      {/* Buổi đã huỷ mà VẪN bị trừ buổi là thông tin hội viên
                          sẽ hỏi — nói ra ngay trên thẻ thay vì để họ tự đối chiếu. */}
                      {b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED' && (
                        <Badge tone="warning">đã trừ buổi</Badge>
                      )}
                    </span>
                  </>
                );
                // Mọi buổi mở được trang chi tiết; buổi còn chờ có sẵn mã QR
                // điểm danh, đổi giờ, huỷ ở đó.
                return (
                  <Link key={b.id} href={`/schedule/${b.id}`} className="event" data-tone={n.mau}>
                    {noiDung}
                    {b.status === 'BOOKED' && (
                      <span className="event-cta">
                        <QrCode size={12} /> Điểm danh · đổi giờ
                      </span>
                    )}
                  </Link>
                );
              })}
            </section>
          );
        })}
      </div>
      <p className="faint small mt-16">Giờ hiển thị theo múi giờ {TZ.replace('_', ' ')}.</p>
    </>
  );
}
