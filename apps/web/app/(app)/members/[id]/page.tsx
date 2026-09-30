import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, CalendarPlus, Mail, Package, Phone, Receipt, ShoppingCart } from 'lucide-react';
import type { BookingItem, MemberDetail } from '@pt/contracts';
import { Avatar, Badge, Card, EmptyState, PageHeader } from '../../../../components/ui';
import { dichNgay, gioVN, ngayISO, ngayNgan, ngayVN, vnd } from '../../../../lib/format';
import { LOAI_GOI, TRANG_THAI_BUOI, TRANG_THAI_HOP_DONG } from '../../../../lib/labels';
import { apiFetch, requireSession } from '../../../../lib/session';
import { ProfileForm } from './profile-form';

export const metadata: Metadata = { title: 'Hồ sơ hội viên' };

export default async function MemberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const homNay = ngayVN();
  const [m, buoi] = await Promise.all([
    apiFetch<MemberDetail>(`/members/${encodeURIComponent(id)}`, session),
    apiFetch<BookingItem[]>(`/bookings?memberId=${encodeURIComponent(id)}&from=${dichNgay(homNay, -30)}&to=${dichNgay(homNay, 60)}`, session),
  ]);

  const laQuay = session.roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION'].includes(r));
  const coGoiDung = m.packages.some((p) => p.status === 'ACTIVE');
  const bayGio = new Date().toISOString();
  const sapToi = buoi.filter((b) => b.status === 'BOOKED' && b.endsAt >= bayGio);
  const ganDay = buoi.filter((b) => !sapToi.includes(b)).reverse().slice(0, 8);
  const tongNo = m.packages.reduce((s, p) => s + p.outstanding, 0);

  return (
    <>
      <PageHeader
        back={{ href: '/members', label: 'Hội viên' }}
        title={
          <span className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Avatar name={m.fullName} />
            {m.fullName}
            {m.status !== 'ACTIVE' && <Badge tone={m.status === 'BANNED' ? 'danger' : 'neutral'}>{m.status === 'BANNED' ? 'Bị cấm' : 'Ngừng tập'}</Badge>}
          </span>
        }
        sub={
          <span className="meta-line">
            <span>{m.code}</span>
            <span>
              <Phone size={13} /> {m.phone}
            </span>
            {m.email && (
              <span>
                <Mail size={13} /> {m.email}
              </span>
            )}
            <span>tham gia {ngayNgan(m.joinedAt)}</span>
          </span>
        }
        actions={
          <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
            {coGoiDung && (
              <Link href={`/schedule/new?memberId=${m.id}`} className="btn btn-secondary">
                <CalendarPlus size={16} /> Đặt lịch
              </Link>
            )}
            {laQuay && (
              <Link href={`/members/${m.id}/sell`} className="btn btn-primary">
                <ShoppingCart size={16} /> Bán gói
              </Link>
            )}
          </div>
        }
      />

      <div className="stack" style={{ gap: 20 }}>
        <Card
          flush
          title="Hợp đồng"
          desc={tongNo > 0 ? <span className="text-danger">Còn nợ {vnd(tongNo)} ₫</span> : `${m.packages.length} hợp đồng`}
          actions={
            laQuay && tongNo > 0 ? (
              <Link href={`/invoices?memberId=${m.id}`} className="btn btn-ghost btn-sm">
                <Receipt size={14} /> Hoá đơn
              </Link>
            ) : undefined
          }
        >
          {m.packages.length === 0 ? (
            <EmptyState
              icon={Package}
              title="Chưa mua gói nào"
              action={laQuay ? <Link href={`/members/${m.id}/sell`} className="btn btn-primary btn-sm">Bán gói đầu tiên</Link> : undefined}
            />
          ) : (
            <div className="table-wrap">
              <table className="table table-flush">
                <thead>
                  <tr>
                    <th>Gói</th>
                    <th>HLV</th>
                    <th className="num">Còn / tổng</th>
                    <th className="num">Đã đặt</th>
                    <th>Hạn dùng</th>
                    <th className="num">Còn nợ (₫)</th>
                    <th>Trạng thái</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {m.packages.map((p) => {
                    const tt = TRANG_THAI_HOP_DONG[p.status] ?? { text: p.status, tone: 'neutral' as const };
                    const sapHet = p.status === 'ACTIVE' && p.expiresOn <= dichNgay(homNay, 14);
                    return (
                      <tr key={p.id}>
                        <td>
                          <div className="cell-main">{p.name}</div>
                          <div className="cell-sub">
                            {p.code} · {LOAI_GOI[p.kind]?.text ?? p.kind}
                          </div>
                        </td>
                        <td>{p.trainerName ?? <span className="faint">—</span>}</td>
                        <td className="num">
                          <span className={p.sessionsRemaining <= 3 && p.status === 'ACTIVE' ? 'strong text-danger' : 'strong'}>
                            {p.sessionsRemaining}
                          </span>
                          <span className="faint"> / {p.sessionsTotal}</span>
                        </td>
                        <td className="num">{p.sessionsBooked}</td>
                        <td className={sapHet ? 'nowrap text-warning' : 'nowrap'}>{ngayISO(p.expiresOn)}</td>
                        <td className={p.outstanding > 0 ? 'num strong text-danger' : 'num faint'}>
                          {p.outstanding > 0 ? vnd(p.outstanding) : '—'}
                        </td>
                        <td>
                          <Badge tone={tt.tone} dot>
                            {tt.text}
                          </Badge>
                        </td>
                        <td>
                          {p.status === 'ACTIVE' && p.sessionsRemaining > p.sessionsBooked && (
                            <Link href={`/schedule/new?memberId=${m.id}&packageId=${p.id}`} className="btn btn-ghost btn-sm">
                              <CalendarPlus size={14} /> Đặt
                            </Link>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="form-grid" style={{ alignItems: 'start', gap: 20 }}>
          <Card title="Buổi tập" desc={`${sapToi.length} buổi sắp tới`}>
            {sapToi.length === 0 && ganDay.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>Chưa có buổi nào trong 30 ngày qua và 60 ngày tới.</p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {[...sapToi, ...ganDay].map((b) => {
                  const n = TRANG_THAI_BUOI[b.status] ?? { text: b.status, tone: 'neutral' as const };
                  return (
                    <Link key={b.id} href={`/schedule/${b.id}`} className="row panel" style={{ gap: 10, padding: '8px 12px' }}>
                      <span className="row-start" style={{ gap: 8, minWidth: 0 }}>
                        <CalendarClock size={15} className="faint" />
                        <span className="tabular">
                          {ngayISO(ngayVN(b.startsAt)).slice(0, 5)} · {gioVN(b.startsAt)}
                        </span>
                        <span className="muted small">{b.trainerName}</span>
                      </span>
                      <Badge tone={n.tone}>{n.text}</Badge>
                    </Link>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="Hồ sơ" desc="Họ tên và số điện thoại thuộc tài khoản của hội viên, không sửa ở đây.">
            <ProfileForm member={m} readOnly={!laQuay} />
          </Card>
        </div>
      </div>
    </>
  );
}
