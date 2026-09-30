import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, Package, QrCode, UserRound } from 'lucide-react';
import type { BookingItem } from '@pt/contracts';
import { BookingActions } from '../../../../components/booking-actions';
import { Badge, Card, PageHeader } from '../../../../components/ui';
import { TZ, gioVN, ngayGioVN, ngayVN } from '../../../../lib/format';
import { CACH_DIEM_DANH, TRANG_THAI_BUOI } from '../../../../lib/labels';
import { apiFetch, requireSession } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Buổi tập' };

export default async function BookingPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const b = await apiFetch<BookingItem>(`/bookings/${encodeURIComponent(id)}`, session);
  const n = TRANG_THAI_BUOI[b.status] ?? { text: b.status, tone: 'neutral' as const };
  const cach = b.checkinMethod ? (CACH_DIEM_DANH[b.checkinMethod] ?? { text: b.checkinMethod, ho: false }) : null;
  // Người CHỈ là PT thì huỷ với tư cách PT; lễ tân / quản lý là STAFF. Cả hai
  // đều không trừ buổi — khác nhau ở trạng thái ghi lại (ai huỷ).
  const vai = session.roles.some((r) => r === 'OWNER' || r === 'ADMIN' || r === 'RECEPTION') ? 'STAFF' : 'PT';

  return (
    <>
      <PageHeader
        back={{ href: `/schedule?from=${ngayVN(b.startsAt)}`, label: 'Lịch tập' }}
        title={
          <span className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
            {gioVN(b.startsAt)} – {gioVN(b.endsAt)}
            <Badge tone={n.tone} dot>
              {n.text}
            </Badge>
          </span>
        }
        sub={new Date(b.startsAt).toLocaleDateString('vi-VN', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })}
        actions={
          b.status === 'BOOKED' ? (
            <Link href={`/checkin/${b.id}`} className="btn btn-primary">
              <QrCode size={16} /> Mở mã điểm danh
            </Link>
          ) : undefined
        }
      />

      <div className="stack" style={{ gap: 20 }}>
        <Card>
          <dl className="dl">
            <div>
              <dt>
                <UserRound size={14} /> Hội viên
              </dt>
              <dd>
                <Link className="link" href={`/members/${b.memberId}`}>
                  {b.memberName}
                </Link>{' '}
                <span className="faint">({b.memberCode})</span>
              </dd>
            </div>
            <div>
              <dt>Huấn luyện viên</dt>
              <dd>{b.trainerName}</dd>
            </div>
            <div>
              <dt>
                <Package size={14} /> Hợp đồng
              </dt>
              <dd>
                {b.packageCode} · còn {b.sessionsRemaining} buổi
              </dd>
            </div>
            {b.checkinAt && (
              <div>
                <dt>
                  <CalendarClock size={14} /> Điểm danh
                </dt>
                <dd>
                  {ngayGioVN(b.checkinAt)}
                  {cach && (
                    <>
                      {' · '}
                      {cach.ho ? <Badge tone="warning">{cach.text}</Badge> : <span className="muted">{cach.text}</span>}
                    </>
                  )}
                </dd>
              </div>
            )}
            {b.checkinNote && (
              <div>
                <dt>Lý do điểm danh hộ</dt>
                <dd>{b.checkinNote}</dd>
              </div>
            )}
            {b.deducted && b.status !== 'CHECKED_IN' && b.status !== 'COMPLETED' && (
              <div>
                <dt>Trừ buổi</dt>
                <dd className="text-warning strong">Buổi này đã bị trừ khỏi gói</dd>
              </div>
            )}
            {b.cancelReason && (
              <div>
                <dt>Lý do</dt>
                <dd>{b.cancelReason}</dd>
              </div>
            )}
            {b.note && (
              <div>
                <dt>Ghi chú</dt>
                <dd>{b.note}</dd>
              </div>
            )}
          </dl>
        </Card>

        {b.status === 'BOOKED' && (
          <Card title="Thao tác" desc="Đổi giờ và huỷ bởi phòng tập không trừ buổi của hội viên.">
            <BookingActions booking={b} vai={vai} />
          </Card>
        )}
      </div>
    </>
  );
}
