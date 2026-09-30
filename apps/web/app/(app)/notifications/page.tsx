import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleAlert, Clock, MessageSquareText, Send } from 'lucide-react';
import type { OutboxRow, OutboxStats, Paged } from '@pt/contracts';
import { Avatar, Badge, Card, EmptyState, PageHeader, StatCard } from '../../../components/ui';
import { ngayGioVN } from '../../../lib/format';
import { TEN_KENH, TRANG_THAI_TIN, lyDoTin } from '../../../lib/labels';
import { apiFetch, requireSession } from '../../../lib/session';
import { RetryButton } from './retry-button';

export const metadata: Metadata = { title: 'Tin nhắn' };

const SIZE = 50;
const TABS = [
  { key: '', label: 'Tất cả' },
  { key: 'PENDING', label: 'Chờ gửi' },
  { key: 'SENT', label: 'Đã gửi' },
  { key: 'FAILED', label: 'Lỗi' },
  { key: 'SKIPPED', label: 'Bỏ qua' },
];

/**
 * Nhật ký hộp thư đi — nơi lễ tân trả lời câu "sao em không nhận được tin?".
 *
 * Cột "Lý do" là thứ quan trọng nhất ở đây: tin bị bỏ qua vì hội viên chưa có
 * số điện thoại cần một hành động khác hẳn tin bị bỏ qua vì OA hết phiên.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; page?: string }>;
}) {
  const session = await requireSession();
  const sp = await searchParams;
  const status = TABS.some((t) => t.key === sp.status) ? sp.status! : '';
  const page = Math.max(1, Number(sp.page) || 1);

  const [data, stats] = await Promise.all([
    apiFetch<Paged<OutboxRow>>(`/notifications?size=${SIZE}&page=${page}${status ? `&status=${status}` : ''}`, session),
    apiFetch<OutboxStats>('/notifications/stats', session),
  ]);

  const s = stats.byStatus;
  const dangCho = (s.PENDING ?? 0) + (s.SENDING ?? 0);
  const soTrang = Math.max(1, Math.ceil(data.total / SIZE));
  const link = (p: number) => `/notifications?${new URLSearchParams({ ...(status ? { status } : {}), page: String(p) })}`;

  return (
    <>
      <PageHeader title="Tin nhắn" sub="Mọi tin hệ thống gửi cho hội viên qua Zalo, 30 ngày gần nhất" />

      <div className="stats">
        <StatCard label="Đã gửi tháng này" value={stats.sentThisMonth} unit="tin" icon={Send} tone="success" meta="tính phí theo Zalo" />
        <StatCard label="Đang chờ gửi" value={dangCho} unit="tin" icon={Clock} tone={dangCho > 0 ? 'info' : undefined} meta="worker gửi trong vài giây" />
        <StatCard
          label="Lỗi"
          value={s.FAILED ?? 0}
          unit="tin"
          icon={CircleAlert}
          tone={(s.FAILED ?? 0) > 0 ? 'danger' : undefined}
          meta={(s.FAILED ?? 0) > 0 ? 'xem lý do và gửi lại' : 'không có tin lỗi'}
        />
        <StatCard
          label="Bỏ qua"
          value={s.SKIPPED ?? 0}
          unit="tin"
          icon={MessageSquareText}
          tone={(s.SKIPPED ?? 0) > 0 ? 'warning' : undefined}
          meta="thiếu cấu hình hoặc số điện thoại"
        />
      </div>

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc theo trạng thái">
            {TABS.map((t) => (
              <Link
                key={t.key}
                href={t.key ? `/notifications?status=${t.key}` : '/notifications'}
                aria-current={status === t.key ? 'page' : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          <span className="small muted">{data.total} tin</span>
        </div>

        {data.items.length === 0 ? (
          <EmptyState
            icon={MessageSquareText}
            title="Chưa có tin nào"
            text="Tin được tạo khi điểm danh, trừ buổi, đăng nhập bằng OTP, hoặc khi chiến dịch chăm sóc chạy."
          />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Thời gian</th>
                  <th>Hội viên</th>
                  <th>Mẫu tin</th>
                  <th>Kênh</th>
                  <th>Trạng thái</th>
                  <th>Lý do</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((m) => {
                  const nhan = TRANG_THAI_TIN[m.status] ?? { text: m.status, tone: 'neutral' as const };
                  const lyDo = lyDoTin(m.lastError);
                  return (
                    <tr key={m.id}>
                      <td className="nowrap">
                        <div className="cell-main tabular">{ngayGioVN(m.createdAt)}</div>
                        {m.sentAt && <div className="cell-sub">gửi {ngayGioVN(m.sentAt)}</div>}
                        {m.deliveredAt && <div className="cell-sub text-success">đã nhận {ngayGioVN(m.deliveredAt)}</div>}
                      </td>
                      <td>
                        {m.memberName ? (
                          <div className="cell-person" style={{ minWidth: 160 }}>
                            <Avatar name={m.memberName} size="sm" />
                            <div>
                              <div className="cell-main">{m.memberName}</div>
                              <div className="cell-sub">{m.memberCode}</div>
                            </div>
                          </div>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td style={{ minWidth: 160 }}>{m.templateName}</td>
                      <td className="nowrap small">{TEN_KENH[m.channel] ?? m.channel}</td>
                      <td className="nowrap">
                        <Badge tone={nhan.tone} dot>
                          {nhan.text}
                        </Badge>
                        {m.attempts > 1 && <div className="cell-sub">{m.attempts} lần thử</div>}
                      </td>
                      <td className="small" style={{ minWidth: 200, maxWidth: 320 }} title={m.lastError ?? undefined}>
                        {lyDo ?? <span className="faint">—</span>}
                      </td>
                      <td className="num">
                        {(m.status === 'FAILED' || m.status === 'SKIPPED') && m.templateCode !== 'OTP_LOGIN' && (
                          <RetryButton id={m.id} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {soTrang > 1 && (
          <div className="card-foot row" style={{ justifyContent: 'space-between' }}>
            <span className="small muted">
              Trang {page} / {soTrang}
            </span>
            <div className="btn-group">
              {page > 1 && (
                <Link href={link(page - 1)}>
                  Trang trước
                </Link>
              )}
              {page < soTrang && (
                <Link href={link(page + 1)}>
                  Trang sau
                </Link>
              )}
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
