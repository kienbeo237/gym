import type { Metadata } from 'next';
import Link from 'next/link';
import { CalendarClock, Search, UserPlus, Users, X } from 'lucide-react';
import type { MemberSummary, Paged } from '@pt/contracts';
import { Avatar, Badge, Card, EmptyState, PageHeader } from '../../../components/ui';
import { ngayGioVN } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Hội viên' };

/**
 * Server Component: gọi API bằng token trong cookie httpOnly, render sẵn HTML.
 * Token không bao giờ đi xuống JavaScript của trình duyệt.
 */
export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requireSession();
  const { q } = await searchParams;
  const data = await apiFetch<Paged<MemberSummary>>(
    `/members?size=50${q ? `&q=${encodeURIComponent(q)}` : ''}`,
    session,
  );

  // Chỉ tính người ĐANG có gói: không có gói thì không có gì để gia hạn.
  const sapHet = data.items.filter((m) => m.activePackages > 0 && m.sessionsRemaining <= 3).length;

  return (
    <>
      <PageHeader
        title="Hội viên"
        sub={
          <>
            {session.tenantName} · <span className="num">{data.total}</span> hội viên
          </>
        }
        actions={
          session.roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION'].includes(r)) ? (
            <Link href="/members/new" className="btn btn-primary">
              <UserPlus size={16} /> Thêm hội viên
            </Link>
          ) : undefined
        }
      />

      <Card flush>
        <div className="toolbar">
          <form className="search" role="search">
            <label className="input-wrap">
              <span className="sr-only">Tìm hội viên</span>
              <Search size={17} />
              <input
                className="input"
                name="q"
                defaultValue={q ?? ''}
                placeholder="Tìm theo tên, số điện thoại hoặc mã"
              />
            </label>
          </form>
          <div className="page-actions">
            {q && (
              <Link href="/members" className="btn btn-ghost btn-sm">
                <X size={15} /> Bỏ lọc “{q}”
              </Link>
            )}
            {sapHet > 0 && (
              <Badge tone="danger" dot>
                {sapHet} người sắp hết buổi
              </Badge>
            )}
          </div>
        </div>

        {data.items.length === 0 ? (
          <EmptyState
            icon={Users}
            title={q ? 'Không tìm thấy hội viên' : 'Chưa có hội viên nào'}
            text={q ? `Không có hội viên nào khớp “${q}”. Thử tìm bằng số điện thoại hoặc mã.` : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Hội viên</th>
                  <th>Số điện thoại</th>
                  <th className="num">Gói đang dùng</th>
                  <th className="num">Buổi còn lại</th>
                  <th>Buổi tập kế tiếp</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="cell-person">
                        <Avatar name={m.fullName} />
                        <div>
                          <Link href={`/members/${m.id}`} className="cell-main link">
                            {m.fullName}
                          </Link>
                          <div className="cell-sub">{m.code}</div>
                        </div>
                      </div>
                    </td>
                    <td className="nowrap tabular">{m.phone}</td>
                    <td className="num">{m.activePackages}</td>
                    <td className="num">
                      {/* Dưới 3 buổi là ngưỡng chiến dịch nhắc gia hạn — tô đỏ để
                          lễ tân thấy ngay mà không phải mở báo cáo. */}
                      {m.activePackages === 0 ? (
                        <span className="faint">Không có gói</span>
                      ) : m.sessionsRemaining <= 3 ? (
                        <Badge tone="danger">{m.sessionsRemaining}</Badge>
                      ) : (
                        <span className="strong">{m.sessionsRemaining}</span>
                      )}
                    </td>
                    <td className="nowrap">
                      {m.nextBookingAt ? (
                        <span className="row-start" style={{ gap: 7 }}>
                          <CalendarClock size={15} className="faint" />
                          {ngayGioVN(m.nextBookingAt)}
                        </span>
                      ) : (
                        <span className="faint">Chưa đặt lịch</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.total > data.items.length && (
          <div className="card-foot">
            Đang hiện {data.items.length}/{data.total} hội viên — thu hẹp bằng ô tìm kiếm để thấy người cần tìm.
          </div>
        )}
      </Card>
    </>
  );
}
