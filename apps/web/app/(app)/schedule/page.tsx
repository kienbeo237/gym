import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { CalendarPlus, ChevronLeft, ChevronRight, QrCode } from 'lucide-react';
import type { BookingItem, TrainerOption } from '@pt/contracts';
import { Badge, PageHeader } from '../../../components/ui';
import { TZ, dichNgay, gioVN, ngayISO, ngayVN } from '../../../lib/format';
import { apiFetch, requireSession, trainerIdCuaToi } from '../../../lib/session';
import { ScheduleToolbar } from './schedule-toolbar';

export const metadata: Metadata = { title: 'Lịch tập' };

const THU = ['CN', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
const THU_DAY_DU = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

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

const LA_NGAY = /^\d{4}-\d{2}-\d{2}$/;
const LA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Chiều cao một giờ trên lưới, px. Buổi 60 phút đủ chỗ cho giờ + tên + HLV. */
const CAO_GIO = 64;

type Lich = { view: 'day' | 'week'; date: string; trainer: string };

const duongDan = (l: Lich) => {
  const p = new URLSearchParams({ view: l.view, date: l.date });
  if (l.trainer) p.set('trainer', l.trainer);
  return `/schedule?${p.toString()}`;
};

/** Phút kể từ 0h theo giờ Việt Nam. */
const phutVN = (iso: string) => {
  const [h, m] = gioVN(iso).split(':').map(Number) as [number, number];
  return h * 60 + m;
};

const dauTuan = (d: string) => {
  const thu = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dichNgay(d, thu === 0 ? -6 : 1 - thu);
};

type ODat = { b: BookingItem; dau: number; cuoi: number; lan: number; soLan: number };

/**
 * Chia làn cho các buổi chồng giờ trong một ngày (một HLV dạy hai người cùng
 * lúc, hay xem "tất cả HLV"). Gom thành cụm chồng nhau liên tiếp; trong cụm,
 * mỗi buổi vào làn trống đầu tiên; mọi buổi của cụm chia đều bề ngang theo số
 * làn của cụm — cụm khác không bị hẹp lây.
 */
function chiaLan(items: BookingItem[]): ODat[] {
  const ds = items
    .map((b) => ({ b, dau: phutVN(b.startsAt), cuoi: Math.max(phutVN(b.endsAt), phutVN(b.startsAt) + 15), lan: 0, soLan: 1 }))
    .sort((a, b) => a.dau - b.dau || b.cuoi - a.cuoi);
  let cum: ODat[] = [];
  let hetCum = -1;
  const dongCum = () => {
    const n = Math.max(1, ...cum.map((x) => x.lan + 1));
    for (const x of cum) x.soLan = n;
    cum = [];
  };
  for (const o of ds) {
    if (o.dau >= hetCum) dongCum();
    const ban = new Set(cum.filter((x) => x.cuoi > o.dau).map((x) => x.lan));
    while (ban.has(o.lan)) o.lan++;
    cum.push(o);
    hetCum = Math.max(hetCum, o.cuoi);
  }
  dongCum();
  return ds;
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; date?: string; from?: string; trainer?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const ua = (await headers()).get('user-agent') ?? '';

  // Mốc "hôm nay" theo giờ Việt Nam, không theo giờ máy chủ — máy chủ đặt ở
  // UTC thì sau 17h giờ VN đã sang ngày mới.
  const homNay = ngayVN();
  // Điện thoại mặc định xem theo NGÀY: 7 cột trên màn 390px không đọc được.
  const view: Lich['view'] = sp.view === 'day' || sp.view === 'week' ? sp.view : /Mobi|Android/i.test(ua) ? 'day' : 'week';
  // `from` là tham số cũ (đầu tuần) — link đã gửi đi vẫn mở đúng tuần.
  const date = [sp.date, sp.from].find((d) => d && LA_NGAY.test(d)) ?? homNay;

  // HLV mở lịch thì mặc định thấy lịch CỦA MÌNH; muốn xem cả phòng chọn "Tất cả".
  const cuaToi = trainerIdCuaToi(session);
  const laChiHLV = session.roles.includes('PT') && !session.roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION'].includes(r));
  const trainer = sp.trainer !== undefined ? sp.trainer : laChiHLV && cuaToi ? cuaToi : '';
  const loc = LA_UUID.test(trainer) ? trainer : null;
  const lich: Lich = { view, date, trainer };

  const tu = view === 'day' ? date : dauTuan(date);
  const den = view === 'day' ? date : dichNgay(tu, 6);
  const buoc = view === 'day' ? 1 : 7;

  const [bookings, trainers] = await Promise.all([
    apiFetch<BookingItem[]>(`/bookings?from=${tu}&to=${den}${loc ? `&trainerId=${loc}` : ''}`, session),
    apiFetch<TrainerOption[]>('/trainers/options', session),
  ]);

  const ngay = Array.from({ length: view === 'day' ? 1 : 7 }, (_, i) => dichNgay(tu, i));
  const theoNgay = new Map<string, BookingItem[]>(ngay.map((d) => [d, []]));
  for (const b of bookings) theoNgay.get(ngayVN(b.startsAt))?.push(b);

  // Khung giờ hiển thị: 6h–21h, nới ra nếu có buổi sớm/muộn hơn.
  const gioDau = Math.min(6, ...bookings.map((b) => Math.floor(phutVN(b.startsAt) / 60)));
  const gioCuoi = Math.max(21, ...bookings.map((b) => Math.ceil(phutVN(b.endsAt) / 60) || 24));
  const soGio = gioCuoi - gioDau;
  const gioIdx = Array.from({ length: soGio }, (_, i) => gioDau + i);
  const bayGio = phutVN(new Date().toISOString());

  const daTap = bookings.filter((b) => b.status === 'CHECKED_IN' || b.status === 'COMPLETED').length;
  const conCho = bookings.filter((b) => b.status === 'BOOKED').length;
  const vangHuy = bookings.filter((b) => b.status.startsWith('CANCELLED') || b.status === 'NO_SHOW').length;

  const coHomNay = homNay >= tu && homNay <= den;
  const nhanNgay =
    view === 'day'
      ? `${THU_DAY_DU[new Date(`${date}T00:00:00Z`).getUTCDay()]}, ${ngayISO(date)}`
      : new Date(`${tu}T00:00:00Z`).toLocaleDateString('vi-VN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const tenLoc = loc ? (loc === cuaToi ? 'lịch của tôi' : trainers.find((t) => t.id === loc)?.fullName) : null;

  return (
    <>
      <PageHeader
        title="Lịch tập"
        sub={
          <>
            {view === 'day' ? ngayISO(tu) : `${ngayISO(tu)} – ${ngayISO(den)}`} ·{' '}
            <span className="num">{bookings.length}</span> buổi{tenLoc ? ` · ${tenLoc}` : ''}
          </>
        }
        actions={
          <Link href="/schedule/new" className="btn btn-primary">
            <CalendarPlus size={16} /> Đặt lịch
          </Link>
        }
      />

      <div className="cal-toolbar mb-16">
        <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div className="btn-group">
            <Link href={duongDan({ ...lich, date: dichNgay(date, -buoc) })} aria-label={view === 'day' ? 'Ngày trước' : 'Tuần trước'}>
              <ChevronLeft size={16} />
            </Link>
            <Link
              href={duongDan({ ...lich, date: homNay })}
              aria-current={coHomNay ? 'page' : undefined}
              style={coHomNay ? { color: 'var(--primary-text)' } : undefined}
            >
              Hôm nay
            </Link>
            <Link href={duongDan({ ...lich, date: dichNgay(date, buoc) })} aria-label={view === 'day' ? 'Ngày sau' : 'Tuần sau'}>
              <ChevronRight size={16} />
            </Link>
          </div>
          <ScheduleToolbar lich={lich} nhan={nhanNgay} trainers={trainers} cuaToi={cuaToi} />
        </div>
        <nav className="segmented" aria-label="Kiểu xem">
          <Link href={duongDan({ ...lich, view: 'day' })} aria-current={view === 'day' ? 'page' : undefined}>
            Ngày
          </Link>
          <Link href={duongDan({ ...lich, view: 'week' })} aria-current={view === 'week' ? 'page' : undefined}>
            Tuần
          </Link>
        </nav>
      </div>

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

      <div className="tg-scroll">
        <div
          className="tg"
          data-view={view}
          style={{ '--cols': ngay.length, '--hour': `${CAO_GIO}px`, '--h': `${soGio * CAO_GIO}px` } as CSSProperties}
        >
          <div className="tg-head">
            <div className="tg-corner" />
            {ngay.map((d) => {
              const thu = new Date(`${d}T00:00:00Z`).getUTCDay();
              const n = theoNgay.get(d)?.length ?? 0;
              return (
                <Link
                  key={d}
                  href={duongDan({ ...lich, view: 'day', date: d })}
                  className="tg-day"
                  data-today={d === homNay}
                  aria-label={`Xem ngày ${THU[thu]} ${ngayISO(d)}`}
                >
                  <span className="tg-day-name">{THU[thu]}</span>
                  <span className="tg-day-date">{d.slice(8)}</span>
                  {view === 'week' && n > 0 && <span className="tg-day-count">{n} buổi</span>}
                </Link>
              );
            })}
          </div>

          <div className="tg-body">
            <div className="tg-hours" aria-hidden>
              {gioIdx.map((h, i) => (
                <span key={h} style={{ top: i * CAO_GIO }}>
                  {String(h).padStart(2, '0')}:00
                </span>
              ))}
            </div>
            {ngay.map((d) => {
              const thu = new Date(`${d}T00:00:00Z`).getUTCDay();
              const items = chiaLan(theoNgay.get(d) ?? []);
              const hienGio = d === homNay && bayGio >= gioDau * 60 && bayGio <= gioCuoi * 60;
              return (
                <section key={d} className="tg-col" data-today={d === homNay} aria-label={`${THU[thu]} ${ngayISO(d)}`}>
                  {items.length === 0 && view === 'day' && <p className="tg-empty">Không có buổi nào</p>}
                  {items.map(({ b, dau, cuoi, lan, soLan }) => {
                    const n = NHAN[b.status];
                    const cao = ((cuoi - dau) / 60) * CAO_GIO;
                    // Buổi đã huỷ mà VẪN bị trừ buổi là thông tin hội viên sẽ
                    // hỏi — nói ra ngay trên thẻ thay vì để họ tự đối chiếu.
                    const truBuoi = b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED';
                    return (
                      <Link
                        key={b.id}
                        href={`/schedule/${b.id}`}
                        className="event tg-event"
                        data-tone={n.mau}
                        data-compact={cao < 52}
                        title={`${gioVN(b.startsAt)}–${gioVN(b.endsAt)} · ${b.memberName} · ${b.trainerName} · ${n.text}${truBuoi ? ' · đã trừ buổi' : ''}`}
                        style={{
                          top: ((dau - gioDau * 60) / 60) * CAO_GIO,
                          height: Math.max(cao, 24) - 2,
                          left: `calc(${(lan / soLan) * 100}% + 2px)`,
                          width: `calc(${100 / soLan}% - 4px)`,
                        }}
                      >
                        <span className="event-time">
                          {gioVN(b.startsAt)} – {gioVN(b.endsAt)}
                        </span>
                        <span className="event-title">{b.memberName}</span>
                        <span className="event-sub">{b.trainerName}</span>
                        {view === 'day' && (
                          <span className="event-tags">
                            <Badge tone={n.mau}>{n.text}</Badge>
                            {truBuoi && <Badge tone="warning">đã trừ buổi</Badge>}
                            {b.status === 'BOOKED' && (
                              <span className="event-cta">
                                <QrCode size={12} /> Điểm danh · đổi giờ
                              </span>
                            )}
                          </span>
                        )}
                      </Link>
                    );
                  })}
                  {hienGio && <div className="tg-now" style={{ top: ((bayGio - gioDau * 60) / 60) * CAO_GIO }} aria-hidden />}
                </section>
              );
            })}
          </div>
        </div>
      </div>
      <p className="faint small mt-16">
        Giờ hiển thị theo múi giờ {TZ.replace('_', ' ')}. Bấm vào một ngày để xem chi tiết ngày đó.
      </p>
    </>
  );
}
