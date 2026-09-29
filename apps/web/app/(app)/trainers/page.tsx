import type { Paged, TrainerSummary } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

export default async function TrainersPage() {
  const session = await requireSession();
  const data = await apiFetch<Paged<TrainerSummary>>('/trainers?size=50', session);

  const thang = new Date().toLocaleDateString('vi-VN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  });

  const tongDoanhThu = data.items.reduce((s, t) => s + t.revenueThisMonth, 0);
  const tongHoaHong = data.items.reduce((s, t) => s + t.commissionThisMonth, 0);

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Huấn luyện viên</h1>
          <p style={S.sub}>
            {data.total} người · số liệu {thang}
          </p>
        </div>
        <div style={S.tiles}>
          <div style={S.tile}>
            <span style={S.tileLabel}>Doanh thu ghi nhận</span>
            <strong style={S.tileValue}>{vnd(tongDoanhThu)} ₫</strong>
            {/* Nói rõ mốc ghi nhận ngay trên màn hình: đây là con số theo BUỔI
                ĐÃ TẬP, không phải tiền đã thu. Hai số này khác nhau và người
                dùng sẽ hỏi. */}
            <span style={S.tileHint}>theo buổi đã tập</span>
          </div>
          <div style={S.tile}>
            <span style={S.tileLabel}>Hoa hồng phải trả</span>
            <strong style={S.tileValue}>{vnd(tongHoaHong)} ₫</strong>
            <span style={S.tileHint}>bán + dạy</span>
          </div>
        </div>
      </header>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Mã</th>
            <th style={S.th}>Họ tên</th>
            <th style={S.th}>Bậc</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Hội viên</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Buổi đã dạy</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Doanh thu</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Hoa hồng</th>
            <th style={S.th}>Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((t) => (
            <tr key={t.id}>
              <td style={S.td}>{t.code}</td>
              <td style={{ ...S.td, fontWeight: 600 }}>
                {t.fullName}
                <div style={S.phone}>{t.phone}</div>
              </td>
              <td style={S.td}>{t.level ?? '—'}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>{t.activeMembers}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>{t.sessionsThisMonth}</td>
              <td style={{ ...S.td, textAlign: 'right' }}>{vnd(t.revenueThisMonth)}</td>
              <td style={{ ...S.td, textAlign: 'right', color: '#93c5fd' }}>
                {vnd(t.commissionThisMonth)}
              </td>
              <td style={S.td}>
                <span style={t.status === 'ACTIVE' ? S.badgeOk : S.badgeOff}>
                  {t.status === 'ACTIVE' ? 'Đang làm' : t.status === 'SUSPENDED' ? 'Tạm nghỉ' : 'Đã nghỉ'}
                </span>
              </td>
            </tr>
          ))}
          {data.items.length === 0 && (
            <tr>
              <td style={{ ...S.td, color: '#8b93a7' }} colSpan={8}>
                Chưa có huấn luyện viên nào.
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
  tiles: { display: 'flex', gap: 12 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px',
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10, minWidth: 160,
  },
  tileLabel: { fontSize: 11, color: '#8b93a7', textTransform: 'uppercase', letterSpacing: 0.4 },
  tileValue: { fontSize: 18 },
  tileHint: { fontSize: 11, color: '#6b7488' },
  table: {
    width: '100%', borderCollapse: 'collapse', background: '#171a21',
    border: '1px solid #262b36', borderRadius: 12, overflow: 'hidden', fontSize: 14,
  },
  th: {
    textAlign: 'left', padding: '11px 14px', fontSize: 12, fontWeight: 600,
    color: '#8b93a7', borderBottom: '1px solid #262b36', textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  td: { padding: '11px 14px', borderBottom: '1px solid #20242e', verticalAlign: 'top' },
  phone: { fontSize: 12, color: '#8b93a7', fontWeight: 400, marginTop: 2 },
  badgeOk: {
    fontSize: 12, padding: '2px 8px', borderRadius: 999,
    background: '#14301f', color: '#4ade80', border: '1px solid #1e5334',
  },
  badgeOff: {
    fontSize: 12, padding: '2px 8px', borderRadius: 999,
    background: '#2a2028', color: '#d1a3b0', border: '1px solid #45303a',
  },
};
