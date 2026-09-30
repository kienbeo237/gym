import { History } from 'lucide-react';
import type { MyLedgerEntry } from '@pt/contracts';
import { EmptyState } from '../../../components/ui';
import { ngayGioVN } from '../../../lib/format';
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
      <h1 className="m-title">Lịch sử buổi tập</h1>
      <p className="m-sub">Mỗi thay đổi về số buổi đều có ở đây, kèm lý do.</p>

      <div className="mt-16">
        {rows.length === 0 ? (
          <div className="card">
            <EmptyState icon={History} title="Chưa có hoạt động nào" />
          </div>
        ) : (
          <ol className="timeline">
            {rows.map((r) => (
              <li key={r.id} className="card list-card" style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                <span className="delta" data-dir={r.delta > 0 ? 'up' : 'down'}>
                  {r.delta > 0 ? `+${r.delta}` : r.delta}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="strong">{r.label}</div>
                  <div className="meta-line mt-4">
                    <span>{ngayGioVN(r.at)}</span>
                    <span>{r.packageCode}</span>
                  </div>
                  {r.note && <div className="small muted mt-4">{r.note}</div>}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="strong num" style={{ fontSize: 16 }}>
                    {r.balanceAfter}
                  </div>
                  <div className="cell-sub nowrap">còn lại</div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
