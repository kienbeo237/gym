import type { MemberSummary, Paged } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

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

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Hội viên</h1>
          <p style={S.sub}>
            {session.tenantName} · {data.total} người
          </p>
        </div>
        <form style={S.searchForm}>
          <input
            name="q"
            defaultValue={q ?? ''}
            placeholder="Tìm theo tên, số điện thoại hoặc mã"
            style={S.search}
          />
        </form>
      </header>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Mã</th>
            <th style={S.th}>Họ tên</th>
            <th style={S.th}>Số điện thoại</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Gói đang dùng</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Buổi còn lại</th>
            <th style={S.th}>Buổi tập kế tiếp</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((m) => (
            <tr key={m.id}>
              <td style={S.td}>{m.code}</td>
              <td style={{ ...S.td, fontWeight: 600 }}>{m.fullName}</td>
              <td style={S.td}>{m.phone}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>{m.activePackages}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>
                {/* Dưới 3 buổi là ngưỡng chiến dịch nhắc gia hạn — tô đỏ để
                    lễ tân thấy ngay mà không phải mở báo cáo. */}
                <span style={m.sessionsRemaining <= 3 ? S.low : undefined}>
                  {m.sessionsRemaining}
                </span>
              </td>
              <td style={S.td}>
                {m.nextBookingAt
                  ? new Date(m.nextBookingAt).toLocaleString('vi-VN', {
                      timeZone: 'Asia/Ho_Chi_Minh',
                    })
                  : '—'}
              </td>
            </tr>
          ))}
          {data.items.length === 0 && (
            <tr>
              <td style={{ ...S.td, color: '#8b93a7' }} colSpan={6}>
                Chưa có hội viên nào khớp điều kiện tìm kiếm.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, marginBottom: 20, flexWrap: 'wrap',
  },
  h1: { margin: 0, fontSize: 24 },
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' },
  searchForm: { margin: 0 },
  search: {
    padding: '9px 12px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#171a21', color: '#e8ebf2', fontSize: 14, width: 'min(320px, 80vw)',
  },
  table: {
    width: '100%', borderCollapse: 'collapse', background: '#171a21',
    border: '1px solid #262b36', borderRadius: 12, overflow: 'hidden', fontSize: 14,
  },
  th: {
    textAlign: 'left', padding: '11px 14px', fontSize: 12, fontWeight: 600,
    color: '#8b93a7', borderBottom: '1px solid #262b36', textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  td: { padding: '11px 14px', borderBottom: '1px solid #20242e' },
  low: { color: '#f87171', fontWeight: 700 },
};
