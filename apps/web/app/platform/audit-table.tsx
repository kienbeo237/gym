import Link from 'next/link';
import type { PlatformAuditRow } from '@pt/contracts';
import { ngayGioVN, vnd } from '../../lib/format';
import { HANH_DONG_NEN_TANG, laThaoTacXem } from '../../lib/labels';

const NHAN: Record<string, string> = {
  note: 'Ghi chú',
  from: 'Từ gói',
  to: 'Sang',
  days: 'Số ngày',
  amount: 'Số tiền',
  paidAmount: 'Nhận',
  bankTxnRef: 'Mã GD',
  transferRef: 'Nội dung CK',
  kind: 'Kiểu',
  slug: 'Tên miền',
  planCode: 'Gói',
  trialDays: 'Dùng thử',
  voidedInvoices: 'Huỷ HĐ',
  q: 'Tìm',
  status: 'Lọc',
  count: 'Kết quả',
  paidThrough: 'Đã trả tới',
  periodStart: 'Kỳ từ',
  phone: 'SĐT',
  level: 'Cấp',
  outcome: 'Kết quả',
  view: 'Lọc',
  newPassword: 'Mật khẩu tạm',
};
const GIA_TRI: Record<string, string> = {
  MANUAL: 'khoá tay',
  BILLING: 'do quá hạn',
  SUPPORT: 'Hỗ trợ',
  OPS: 'Vận hành',
  SUPER: 'Toàn quyền',
  OPEN: 'cần xử lý',
  true: 'có',
  false: 'không',
  MATCHED: 'đã khớp',
  AMOUNT_MISMATCH: 'lệch số tiền',
  ALREADY_SETTLED: 'chuyển trùng',
  NO_MATCH: 'không khớp',
  AMBIGUOUS: 'khớp nhiều HĐ',
};
/** Khoá nội bộ — có trong nhật ký để truy vết, không cần đọc bằng mắt. */
const AN = new Set(['invoiceId', 'page', 'ownerIsNew', 'identityId']);

function chiTiet(d: Record<string, unknown>): string {
  return Object.entries(d)
    .filter(([k, v]) => v !== null && v !== undefined && v !== '' && !AN.has(k))
    .map(([k, v]) => `${NHAN[k] ?? k}: ${typeof v === 'number' && /amount/i.test(k) ? vnd(v) + 'đ' : (GIA_TRI[String(v)] ?? String(v))}`)
    .join(' · ');
}

/**
 * Nhật ký thao tác nền tảng. Thao tác XEM mờ đi: chúng có trong nhật ký (ai đã
 * nhìn dữ liệu phòng nào) nhưng người đọc thường tìm thao tác GHI.
 */
export function AuditTable({ rows, showTenant }: { rows: PlatformAuditRow[]; showTenant?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="table table-flush">
        <thead>
          <tr>
            <th>Thời điểm</th>
            <th>Người thao tác</th>
            {showTenant && <th>Phòng tập</th>}
            <th>Hành động</th>
            <th>Chi tiết</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const xem = laThaoTacXem(a.action);
            return (
              <tr key={a.id} style={xem ? { opacity: 0.6 } : undefined}>
                <td className="nowrap small tabular">{ngayGioVN(a.createdAt)}</td>
                <td className="small">
                  {a.actorName ?? <span className="muted">Hệ thống (job)</span>}
                  {a.ip && <div className="cell-sub mono">{a.ip}</div>}
                </td>
                {showTenant && (
                  <td className="small">
                    {a.tenantId ? (
                      <Link href={`/platform/tenants/${a.tenantId}`} className="link">
                        {a.tenantName ?? a.tenantId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                )}
                <td className={xem ? 'small' : 'small strong'}>{HANH_DONG_NEN_TANG[a.action] ?? a.action}</td>
                <td className="small muted" style={{ maxWidth: 420 }}>
                  {chiTiet(a.detail) || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
