import type { Metadata } from 'next';
import Link from 'next/link';
import { Info, Landmark, Search } from 'lucide-react';
import type { PlatformInvoiceRow } from '@pt/contracts';
import { Alert, Badge, Card, EmptyState, PageHeader } from '../../../components/ui';
import { ngayGioVN, ngayISO, ngayVN, vnd } from '../../../lib/format';
import { TRANG_THAI_HD_SAAS, TRANG_THAI_PHONG } from '../../../lib/labels';
import { apiFetch, duCap, requireSession } from '../../../lib/session';
import { InvoiceActions } from '../invoice-actions';

export const metadata: Metadata = { title: 'Đối soát thu tiền' };

const LOC = [
  { key: 'PENDING', label: 'Chờ thanh toán' },
  { key: 'PAID', label: 'Đã thanh toán' },
  { key: 'WAIVED', label: 'Miễn phí' },
  { key: 'VOID', label: 'Đã huỷ' },
  { key: 'ALL', label: 'Tất cả' },
];

/**
 * Hàng ĐỐI SOÁT: mở sao kê ngân hàng một bên, màn này một bên. Dán nội dung
 * chuyển khoản vào ô tìm (khoảng trắng, chữ hoa/thường không quan trọng —
 * ngân hàng hay nuốt khoảng trắng), khớp số tiền, bấm "Đã nhận tiền".
 */
export default async function PlatformInvoices({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const session = await requireSession();
  const { q, status } = await searchParams;
  const loc = LOC.some((l) => l.key === status) ? status! : 'PENDING';
  const ghi = duCap(session, 'OPS');

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (loc !== 'ALL') qs.set('status', loc);
  const rows = await apiFetch<PlatformInvoiceRow[]>(`/platform/invoices?${qs}`, session);

  const homNay = ngayVN();
  const tong = rows.reduce((s, r) => s + (r.status === 'PAID' ? (r.paidAmount ?? r.amount) : r.amount), 0);
  const link = (s: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (s !== 'PENDING') p.set('status', s);
    const x = p.toString();
    return x ? `/platform/invoices?${x}` : '/platform/invoices';
  };

  return (
    <>
      <PageHeader
        title="Đối soát thu tiền"
        sub={`${rows.length} hoá đơn · ${vnd(tong)}đ`}
      />

      {loc === 'PENDING' && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>
              Dán <strong>nội dung chuyển khoản</strong> từ sao kê vào ô tìm để ra đúng hoá đơn. Chỉ bấm &ldquo;Đã nhận
              tiền&rdquo; khi số tiền trên sao kê khớp — nhận thiếu thì huỷ và phát hành lại đúng số đã thoả thuận.
            </span>
          </Alert>
        </div>
      )}

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc theo trạng thái">
            {LOC.map((l) => (
              <Link key={l.key} href={link(l.key)} aria-current={loc === l.key ? 'page' : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <form className="search" role="search">
            {loc !== 'PENDING' && <input type="hidden" name="status" value={loc} />}
            <label className="input-wrap">
              <span className="sr-only">Tìm hoá đơn</span>
              <Search size={17} />
              <input className="input" name="q" defaultValue={q ?? ''} placeholder="Nội dung CK, tên phòng, mã giao dịch" />
            </label>
          </form>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={Landmark}
            title={q ? 'Không tìm thấy hoá đơn' : 'Không có hoá đơn nào'}
            text={q ? `Không hoá đơn nào khớp “${q}”. Thử bỏ bộ lọc trạng thái.` : 'Không có hoá đơn nào ở trạng thái này.'}
          />
        ) : loc === 'PENDING' ? (
          // Hàng chờ: mỗi hoá đơn một khối, thao tác mở ngay bên dưới — bảng
          // hẹp không đủ chỗ cho form xác nhận.
          <div>
            {rows.map((r) => (
              <div key={r.id} className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
                <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                    <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Link href={`/platform/tenants/${r.tenantId}`} className="strong link">
                        {r.tenantName}
                      </Link>
                      {r.tenantStatus !== 'ACTIVE' && (
                        <Badge tone={TRANG_THAI_PHONG[r.tenantStatus]?.tone}>{TRANG_THAI_PHONG[r.tenantStatus]?.text}</Badge>
                      )}
                    </div>
                    <div className="meta-line">
                      <span>
                        {r.planName} · kỳ {ngayISO(r.periodStart)} – {ngayISO(r.periodEnd)}
                      </span>
                      <span className={r.dueDate < homNay ? 'text-danger' : undefined}>
                        Hạn {ngayISO(r.dueDate)}
                        {r.dueDate < homNay ? ' · quá hạn' : ''}
                      </span>
                      {r.note && <span>Ghi chú: {r.note}</span>}
                    </div>
                  </div>
                  <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                    <span className="strong tabular" style={{ fontSize: 18 }}>
                      {vnd(r.amount)}đ
                    </span>
                    <span className="mono small">{r.transferRef}</span>
                  </div>
                </div>
                {ghi && (
                  <div className="mt-8">
                    <InvoiceActions id={r.id} amount={r.amount} transferRef={r.transferRef} />
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Phòng tập</th>
                  <th>Kỳ</th>
                  <th>Nội dung CK</th>
                  <th className="num">Số tiền</th>
                  <th>Trạng thái</th>
                  <th>Xử lý</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <Link href={`/platform/tenants/${r.tenantId}`} className="cell-main link">
                        {r.tenantName}
                      </Link>
                      <div className="cell-sub">{r.planName}</div>
                    </td>
                    <td className="nowrap small">
                      {ngayISO(r.periodStart)} – {ngayISO(r.periodEnd)}
                    </td>
                    <td className="mono small">{r.transferRef}</td>
                    <td className="num tabular">
                      {vnd(r.status === 'PAID' ? (r.paidAmount ?? r.amount) : r.amount)}
                      {r.status === 'PAID' && r.paidAmount !== null && r.paidAmount !== r.amount && (
                        <div className="cell-sub">HĐ {vnd(r.amount)}</div>
                      )}
                    </td>
                    <td>
                      <Badge tone={TRANG_THAI_HD_SAAS[r.status]?.tone}>{TRANG_THAI_HD_SAAS[r.status]?.text ?? r.status}</Badge>
                    </td>
                    <td className="small">
                      {r.confirmedAt ? (
                        <>
                          <div>
                            {r.confirmedByName ??
                              (r.status === 'PAID' && r.bankTxnRef?.startsWith('SEPAY:') ? 'Tự khớp (SePay)' : 'Hệ thống')}{' '}
                            · {ngayGioVN(r.confirmedAt)}
                          </div>
                          {r.bankTxnRef && <div className="cell-sub mono">GD {r.bankTxnRef}</div>}
                          {r.note && <div className="cell-sub">{r.note}</div>}
                        </>
                      ) : (
                        <span className="muted">{r.note ?? '—'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
