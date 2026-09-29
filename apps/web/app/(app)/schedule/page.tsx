import Link from 'next/link';
import type { BookingItem } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const TZ = 'Asia/Ho_Chi_Minh';
const THU = ['Chủ nhật', 'Thứ hai', 'Thứ ba', 'Thứ tư', 'Thứ năm', 'Thứ sáu', 'Thứ bảy'];

const NHAN: Record<BookingItem['status'], { text: string; mau: 'cho' | 'xong' | 'vang' | 'huy' }> = {
  BOOKED: { text: 'Chờ tập', mau: 'cho' },
  CHECKED_IN: { text: 'Đã điểm danh', mau: 'xong' },
  COMPLETED: { text: 'Đã tập xong', mau: 'xong' },
  NO_SHOW: { text: 'Vắng mặt', mau: 'vang' },
  CANCELLED_BY_MEMBER: { text: 'Hội viên huỷ', mau: 'huy' },
  CANCELLED_BY_PT: { text: 'HLV huỷ', mau: 'huy' },
  CANCELLED_BY_STAFF: { text: 'Phòng tập huỷ', mau: 'huy' },
};

/** Ngày trên tờ lịch VIỆT NAM của một mốc thời gian. */
const ngayVN = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: TZ });
const gioVN = (iso: string) =>
  new Date(iso).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });

function dichNgay(base: string, soNgay: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + soNgay);
  return d.toISOString().slice(0, 10);
}

export default async function SchedulePage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;

  // Tuần bắt đầu từ thứ hai. Mốc "hôm nay" tính theo giờ Việt Nam, không theo
  // giờ máy chủ — máy chủ đặt ở UTC thì sau 17h giờ VN đã sang ngày mới.
  const homNay = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const thuCuaHomNay = new Date(`${homNay}T00:00:00Z`).getUTCDay();
  const dauTuanMacDinh = dichNgay(homNay, thuCuaHomNay === 0 ? -6 : 1 - thuCuaHomNay);
  const from = sp.from ?? dauTuanMacDinh;
  const to = dichNgay(from, 6);

  const bookings = await apiFetch<BookingItem[]>(`/bookings?from=${from}&to=${to}`, session);

  const ngay = Array.from({ length: 7 }, (_, i) => dichNgay(from, i));
  const theoNgay = new Map<string, BookingItem[]>(ngay.map((d) => [d, []]));
  for (const b of bookings) theoNgay.get(ngayVN(b.startsAt))?.push(b);

  const daTap = bookings.filter((b) => b.status === 'CHECKED_IN' || b.status === 'COMPLETED').length;
  const conCho = bookings.filter((b) => b.status === 'BOOKED').length;
  const vangHuy = bookings.filter((b) => b.status.startsWith('CANCELLED') || b.status === 'NO_SHOW').length;

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Lịch tập</h1>
          <p style={S.sub}>
            {from} → {to} · {bookings.length} buổi
          </p>
        </div>
        <div style={S.nav}>
          <Link href={`/schedule?from=${dichNgay(from, -7)}`} style={S.navBtn}>
            ← Tuần trước
          </Link>
          <Link href="/schedule" style={S.navBtn}>
            Tuần này
          </Link>
          <Link href={`/schedule?from=${dichNgay(from, 7)}`} style={S.navBtn}>
            Tuần sau →
          </Link>
        </div>
      </header>

      <div style={S.tiles}>
        <span style={S.tile}>
          <b style={{ color: '#4ade80' }}>{daTap}</b> đã tập
        </span>
        <span style={S.tile}>
          <b style={{ color: '#93c5fd' }}>{conCho}</b> chờ tập
        </span>
        <span style={S.tile}>
          <b style={{ color: '#f87171' }}>{vangHuy}</b> vắng / huỷ
        </span>
      </div>

      <div style={S.grid}>
        {ngay.map((d) => {
          const items = theoNgay.get(d) ?? [];
          const laHomNay = d === homNay;
          const thu = new Date(`${d}T00:00:00Z`).getUTCDay();
          return (
            <section key={d} style={{ ...S.col, ...(laHomNay ? S.colToday : {}) }}>
              <header style={S.colHead}>
                <span style={S.thu}>{THU[thu]}</span>
                <span style={laHomNay ? S.ngayToday : S.ngay}>{d.slice(8)}/{d.slice(5, 7)}</span>
              </header>
              {items.length === 0 && <p style={S.trong}>—</p>}
              {items.map((b) => {
                const n = NHAN[b.status];
                return (
                  <article key={b.id} style={{ ...S.buoi, ...S.vien[n.mau] }}>
                    <div style={S.gio}>
                      {gioVN(b.startsAt)}–{gioVN(b.endsAt)}
                    </div>
                    <div style={S.ten}>{b.memberName}</div>
                    <div style={S.phu}>{b.trainerName}</div>
                    <div style={S.chan}>
                      <span style={S.nhan[n.mau]}>{n.text}</span>
                      {/* Buổi đã huỷ mà VẪN bị trừ buổi là thông tin hội viên
                          sẽ hỏi — nói ra ngay trên thẻ thay vì để họ tự đối chiếu. */}
                      {b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED' && (
                        <span style={S.truBuoi}>đã trừ buổi</span>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })}
      </div>
    </main>
  );
}

const vien = (c: string): React.CSSProperties => ({ borderLeft: `3px solid ${c}` });
const nhan = (bg: string, fg: string): React.CSSProperties => ({
  fontSize: 10, padding: '1px 6px', borderRadius: 999, background: bg, color: fg,
});

const S = {
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, marginBottom: 14, flexWrap: 'wrap',
  } as React.CSSProperties,
  h1: { margin: 0, fontSize: 24 } as React.CSSProperties,
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' } as React.CSSProperties,
  nav: { display: 'flex', gap: 6 } as React.CSSProperties,
  navBtn: {
    padding: '6px 12px', borderRadius: 7, fontSize: 13, textDecoration: 'none',
    color: '#b6bdcd', border: '1px solid #262b36', background: '#171a21',
  } as React.CSSProperties,
  tiles: { display: 'flex', gap: 14, marginBottom: 14, fontSize: 13, color: '#8b93a7' } as React.CSSProperties,
  tile: {} as React.CSSProperties,
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', gap: 8,
  } as React.CSSProperties,
  col: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10,
    padding: 10, minHeight: 160, display: 'flex', flexDirection: 'column', gap: 7,
  } as React.CSSProperties,
  colToday: { borderColor: '#3b82f6' } as React.CSSProperties,
  colHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
    borderBottom: '1px solid #20242e', paddingBottom: 7,
  } as React.CSSProperties,
  thu: { fontSize: 11, color: '#8b93a7' } as React.CSSProperties,
  ngay: { fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  ngayToday: { fontSize: 13, fontWeight: 700, color: '#93c5fd' } as React.CSSProperties,
  trong: { margin: 0, fontSize: 12, color: '#3c424f', textAlign: 'center' } as React.CSSProperties,
  buoi: {
    background: '#0f1115', borderRadius: 7, padding: '7px 9px',
    display: 'flex', flexDirection: 'column', gap: 2,
  } as React.CSSProperties,
  gio: { fontSize: 11, color: '#8b93a7' } as React.CSSProperties,
  ten: { fontSize: 13, fontWeight: 600 } as React.CSSProperties,
  phu: { fontSize: 11, color: '#8b93a7' } as React.CSSProperties,
  chan: { display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 3 } as React.CSSProperties,
  truBuoi: nhan('#2e2a16', '#fbbf24'),
  vien: {
    cho: vien('#3b82f6'),
    xong: vien('#22c55e'),
    vang: vien('#ef4444'),
    huy: vien('#6b7280'),
  },
  nhan: {
    cho: nhan('#1c2436', '#93c5fd'),
    xong: nhan('#14301f', '#4ade80'),
    vang: nhan('#301818', '#f87171'),
    huy: nhan('#23262e', '#8b93a7'),
  },
};
