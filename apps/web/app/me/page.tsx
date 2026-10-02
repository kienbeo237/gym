import Link from 'next/link';
import {
  CalendarClock,
  CalendarPlus,
  ChevronRight,
  CircleAlert,
  FileText,
  Package,
  TriangleAlert,
  UserRound,
  Wallet,
} from 'lucide-react';
import type { MySummary } from '@pt/contracts';
import { EmptyState } from '../../components/ui';
import { TZ, ngayISO, vnd } from '../../lib/format';
import { apiFetch, requireSession } from '../../lib/session';

const MUC_CANH_BAO: Record<MySummary['warnings'][number]['kind'], 'warning' | 'danger'> = {
  LOW_SESSIONS: 'warning',
  EXPIRING: 'warning',
  EXPIRED: 'danger',
  USED_UP: 'danger',
};

function khiNao(phut: number): string {
  if (phut < 0) return 'đã qua giờ hẹn';
  if (phut < 60) return `còn ${phut} phút nữa`;
  if (phut < 60 * 24) return `còn ${Math.round(phut / 60)} giờ nữa`;
  return `còn ${Math.round(phut / 60 / 24)} ngày nữa`;
}

function loiChao(): string {
  const gio = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }));
  if (gio < 11) return 'Chào buổi sáng';
  if (gio < 14) return 'Chào buổi trưa';
  if (gio < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

export default async function MeHome() {
  const session = await requireSession();
  const s = await apiFetch<MySummary>('/me/summary', session);

  const dangDung = s.packages.filter((p) => p.status === 'ACTIVE');

  return (
    <>
      <header className="mb-16">
        <p className="muted small">{loiChao()},</p>
        <h1 className="m-title">{s.fullName.split(' ').slice(-1)[0]} 👋</h1>
        <p className="m-sub">Mã hội viên {s.memberCode}</p>
      </header>

      <section className="hero">
        <div className="hero-label">Tổng số buổi còn lại</div>
        <div className="hero-value">
          {s.totalSessionsRemaining}
          <small>buổi</small>
        </div>
        <div className="hero-chips">
          <span className="hero-chip">
            <Package size={14} /> {dangDung.length} gói đang dùng
          </span>
          {s.totalOutstanding > 0 && (
            <span className="hero-chip">
              <Wallet size={14} /> Còn nợ {vnd(s.totalOutstanding)} ₫
            </span>
          )}
        </div>
      </section>

      {/* Cảnh báo tính ở BACKEND với cùng ngưỡng mà chiến dịch nhắc gia hạn
          dùng. Tính lại ở giao diện thì hội viên thấy "sắp hết" trên màn hình
          mà không nhận tin nhắn, hoặc ngược lại. */}
      {s.warnings.length > 0 && (
        <div className="stack mt-16" style={{ gap: 8 }}>
          {s.warnings.map((w, i) => {
            const muc = MUC_CANH_BAO[w.kind];
            return (
              <div key={i} className="alert" data-tone={muc}>
                {muc === 'danger' ? <CircleAlert size={17} /> : <TriangleAlert size={17} />}
                <div className="alert-body">{w.message}</div>
              </div>
            );
          })}
        </div>
      )}

      <h2 className="m-section">Buổi tập kế tiếp</h2>
      {s.nextBooking ? (
        <Link href="/me/schedule" className="card list-card" style={{ display: 'flex' }}>
          <div className="row">
            <div className="row-start">
              <span className="icon-tile">
                <CalendarClock size={20} />
              </span>
              <div>
                <div className="strong" style={{ fontSize: 15 }}>
                  {new Date(s.nextBooking.startsAt).toLocaleString('vi-VN', {
                    timeZone: TZ,
                    weekday: 'long',
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
                <div className="meta-line mt-4">
                  <span>
                    <UserRound size={13} /> {s.nextBooking.trainerName}
                  </span>
                  <span className="text-primary strong">{khiNao(s.nextBooking.minutesUntil)}</span>
                </div>
              </div>
            </div>
            <ChevronRight size={18} className="faint" />
          </div>
        </Link>
      ) : (
        <div className="card">
          <EmptyState
            icon={CalendarClock}
            title="Chưa có buổi hẹn"
            text="Chọn giờ trống của huấn luyện viên để đặt buổi tiếp theo."
            action={
              <Link href="/me/book" className="btn btn-primary btn-sm">
                <CalendarPlus size={15} /> Đặt lịch
              </Link>
            }
          />
        </div>
      )}

      <h2 className="m-section">Gói tập của bạn</h2>
      {dangDung.length === 0 && (
        <div className="card">
          <EmptyState icon={Package} title="Chưa có gói đang hoạt động" text="Ghé quầy lễ tân để đăng ký gói tập mới." />
        </div>
      )}

      <div className="stack">
        {dangDung.map((p) => {
          // Tổng được dùng gồm cả buổi phòng tập tặng thêm.
          const tong = p.sessionsTotal + p.sessionsBonus;
          const daDung = tong - p.sessionsRemaining;
          const pct = tong > 0 ? Math.round((daDung / tong) * 100) : 0;
          const sapHet = p.sessionsRemaining <= 3;
          return (
            <article key={p.id} className="card list-card">
              <div className="row">
                <div>
                  <div className="strong" style={{ fontSize: 15 }}>
                    {p.name}
                  </div>
                  <div className="cell-sub">{p.code}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className={sapHet ? 'text-danger' : 'text-success'} style={{ fontSize: 22, fontWeight: 800, lineHeight: 1 }}>
                    {p.sessionsRemaining}
                  </div>
                  <div className="cell-sub">buổi còn lại</div>
                </div>
              </div>

              <div className="progress" data-tone={sapHet ? 'danger' : undefined}>
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="row small muted">
                <span>
                  Đã dùng {daDung}/{tong} buổi
                  {p.sessionsBonus > 0 && <span className="text-success"> · tặng {p.sessionsBonus}</span>}
                </span>
                <span>{pct}%</span>
              </div>

              <hr className="divider" />

              <div className="meta-line">
                <span>
                  <CalendarClock size={13} /> Hết hạn {ngayISO(p.expiresOn)}
                  {p.daysLeft >= 0 ? ` · còn ${p.daysLeft} ngày` : ''}
                </span>
                {p.daysLeft < 0 && <span className="text-danger strong">Đã quá hạn</span>}
                {p.trainerName && (
                  <span>
                    <UserRound size={13} /> {p.trainerName}
                  </span>
                )}
                {p.outstanding > 0 && (
                  <span className="text-warning strong">
                    <Wallet size={13} /> Còn nợ {vnd(p.outstanding)} ₫
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <Link href="/me/terms" className="row panel small" style={{ gap: 10, padding: '12px 14px' }}>
        <span className="row-start" style={{ gap: 8 }}>
          <FileText size={15} className="faint" /> Điều khoản & chính sách phòng tập
        </span>
        <ChevronRight size={16} className="faint" />
      </Link>
    </>
  );
}
