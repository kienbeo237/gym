import type { Metadata } from 'next';
import Link from 'next/link';
import { CircleAlert, Receipt, Wallet, X } from 'lucide-react';
import type { InvoiceSummary, Paged } from '@pt/contracts';
import { Avatar, Badge, Card, EmptyState, PageHeader, StatCard } from '../../../components/ui';
import { ngayISO, ngayNgan, vnd, vndGon } from '../../../lib/format';
import { TRANG_THAI_HOA_DON } from '../../../lib/labels';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Hoá đơn' };

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string; memberId?: string }>;
}) {
  const session = await requireSession();
  const { loc, memberId } = await searchParams;
  const theoNguoi = memberId && /^[0-9a-f-]{36}$/i.test(memberId) ? memberId : undefined;

  const qs =
    (loc === 'no' ? '&unpaidOnly=true' : loc === 'quahan' ? '&overdueOnly=true&unpaidOnly=true' : '') +
    (theoNguoi ? `&memberId=${theoNguoi}` : '');
  const data = await apiFetch<Paged<InvoiceSummary>>(`/invoices?size=50${qs}`, session);

  const tongPhaiThu = data.items.reduce((s, i) => s + Math.max(0, i.outstanding), 0);
  const tongDaThu = data.items.reduce((s, i) => s + i.paidAmount, 0);
  const soQuaHan = data.items.filter((i) => i.overdueCount > 0).length;

  const tabs = [
    { key: '', label: 'Tất cả' },
    { key: 'no', label: 'Còn nợ' },
    { key: 'quahan', label: 'Quá hạn' },
  ];

  return (
    <>
      <PageHeader title="Hoá đơn" sub={`${data.total} hoá đơn`} />

      <div className="stats">
        <StatCard
          label="Còn phải thu"
          value={vndGon(tongPhaiThu)}
          unit="₫"
          icon={Wallet}
          tone={tongPhaiThu > 0 ? 'warning' : undefined}
          meta="trên danh sách đang xem"
        />
        <StatCard label="Đã thu" value={vndGon(tongDaThu)} unit="₫" icon={Receipt} tone="success" meta="trên danh sách đang xem" />
        <StatCard
          label="Có đợt quá hạn"
          value={soQuaHan}
          unit="hoá đơn"
          icon={CircleAlert}
          tone={soQuaHan > 0 ? 'danger' : undefined}
          meta={soQuaHan > 0 ? 'cần liên hệ hội viên' : 'không có khoản nào trễ hạn'}
        />
      </div>

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc hoá đơn">
            {tabs.map((t) => (
              <Link
                key={t.key}
                href={`/invoices?${new URLSearchParams({ ...(t.key ? { loc: t.key } : {}), ...(theoNguoi ? { memberId: theoNguoi } : {}) })}`}
                aria-current={(loc ?? '') === t.key ? 'page' : undefined}
              >
                {t.label}
              </Link>
            ))}
          </nav>
          {theoNguoi && (
            <Link href={loc ? `/invoices?loc=${loc}` : '/invoices'} className="btn btn-ghost btn-sm">
              <X size={15} /> Bỏ lọc {data.items[0]?.memberName ?? 'hội viên'}
            </Link>
          )}
        </div>

        {data.items.length === 0 ? (
          <EmptyState icon={Receipt} title="Không có hoá đơn nào" text="Không có hoá đơn nào khớp bộ lọc đang chọn." />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Số hoá đơn</th>
                  <th>Hội viên</th>
                  <th>Ngày lập</th>
                  <th className="num">Phải thu (₫)</th>
                  <th className="num">Đã thu (₫)</th>
                  <th className="num">Còn lại (₫)</th>
                  <th>Trả góp</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((inv) => {
                  const nhan = TRANG_THAI_HOA_DON[inv.status] ?? { text: inv.status, tone: 'neutral' as const };
                  return (
                    <tr key={inv.id}>
                      <td>
                        <Link href={`/invoices/${inv.id}`} className="link nowrap">
                          {inv.code}
                        </Link>
                      </td>
                      <td>
                        <div className="cell-person" style={{ minWidth: 160 }}>
                          <Avatar name={inv.memberName} size="sm" />
                          <div>
                            <div className="cell-main">{inv.memberName}</div>
                            <div className="cell-sub">{inv.memberCode}</div>
                          </div>
                        </div>
                      </td>
                      <td className="nowrap">{ngayNgan(inv.issuedAt)}</td>
                      <td className="num">{vnd(inv.totalAmount)}</td>
                      <td className="num">{vnd(inv.paidAmount)}</td>
                      <td className="num strong">
                        {inv.outstanding > 0 ? vnd(inv.outstanding) : <span className="faint">—</span>}
                      </td>
                      <td className="nowrap">
                        {inv.isInstallment ? (
                          // Ngày tới hạn là thứ lễ tân cần thấy ngay, không phải
                          // chỉ biết "có trả góp".
                          inv.nextDueDate ? (
                            inv.overdueCount > 0 ? (
                              <Badge tone="danger">Quá hạn {inv.overdueCount} đợt</Badge>
                            ) : (
                              <span className="small">Hạn {ngayISO(inv.nextDueDate)}</span>
                            )
                          ) : (
                            <span className="small text-success">Đã xong</span>
                          )
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </td>
                      <td>
                        <Badge tone={nhan.tone} dot>
                          {nhan.text}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
