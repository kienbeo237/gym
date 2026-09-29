import type { MyLedgerEntry } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

/**
 * Lịch sử đọc từ SỔ CÁI, không từ bảng lịch tập.
 *
 * Sổ cái là nguồn sự thật và mỗi dòng có lý do — đó chính là thứ dập tranh chấp
 * "em tập 8 buổi sao trừ 10". Đọc từ lịch tập sẽ bỏ sót buổi được tặng và các
 * điều chỉnh của phòng tập.
 */
export default async function MeHistory() {
  const session = await requireSession();
  const rows = await apiFetch<MyLedgerEntry[]>('/me/ledger?limit=100', session);

  return (
    <>
      <h1 style={S.h1}>Lịch sử buổi tập</h1>
      <p style={S.sub}>Mỗi thay đổi về số buổi đều có ở đây, kèm lý do.</p>

      {rows.length === 0 && <p style={S.trong}>Chưa có hoạt động nào.</p>}

      <ol style={S.list}>
        {rows.map((r) => (
          <li key={r.id} style={S.item}>
            <span style={r.delta > 0 ? S.cong : S.tru}>
              {r.delta > 0 ? `+${r.delta}` : r.delta}
            </span>
            <div style={S.noiDung}>
              <strong style={S.nhan}>{r.label}</strong>
              <span style={S.meta}>
                {new Date(r.at).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} ·{' '}
                {r.packageCode}
              </span>
              {r.note && <span style={S.ghiChu}>{r.note}</span>}
            </div>
            <span style={S.duSau}>còn {r.balanceAfter}</span>
          </li>
        ))}
      </ol>
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  h1: { margin: 0, fontSize: 22 },
  sub: { margin: '3px 0 16px', fontSize: 13, color: '#8b93a7' },
  trong: { fontSize: 13, color: '#8b93a7' },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  item: {
    display: 'flex', gap: 12, alignItems: 'flex-start',
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10, padding: '12px 14px',
  },
  cong: { fontSize: 16, fontWeight: 700, color: '#4ade80', minWidth: 34 },
  tru: { fontSize: 16, fontWeight: 700, color: '#f87171', minWidth: 34 },
  noiDung: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  nhan: { fontSize: 14 },
  meta: { fontSize: 11, color: '#8b93a7' },
  ghiChu: { fontSize: 12, color: '#b6bdcd', marginTop: 2 },
  duSau: { fontSize: 11, color: '#8b93a7', whiteSpace: 'nowrap' },
};
