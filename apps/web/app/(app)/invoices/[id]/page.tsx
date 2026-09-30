import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote, CalendarClock, FileDown, FileText, History, Info, Wallet } from 'lucide-react';
import type { InvoiceDetail } from '@pt/contracts';
import { Badge, Card, EmptyState, PageHeader, StatCard } from '../../../../components/ui';
import { ngayGioVN, ngayISO, ngayVN, vnd } from '../../../../lib/format';
import { HINH_THUC_TT, TRANG_THAI_HOA_DON } from '../../../../lib/labels';
import { apiFetch, requireSession } from '../../../../lib/session';
import { InvoiceActions } from './invoice-actions';

export const metadata: Metadata = { title: 'Chi tiết hoá đơn' };

const TEN_DOT: Record<string, string> = {
  DUE: 'Chưa đến hạn',
  OVERDUE: 'Quá hạn',
  PAID: 'Đã thu',
  WAIVED: 'Được miễn',
};

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const inv = await apiFetch<InvoiceDetail>(`/invoices/${encodeURIComponent(id)}`, session);

  const homNay = ngayVN();
  const nhan = TRANG_THAI_HOA_DON[inv.status] ?? { text: inv.status, tone: 'neutral' as const };
  const tyLe = inv.totalAmount > 0 ? Math.min(100, Math.round((inv.paidAmount / inv.totalAmount) * 100)) : 100;
  const coTheThu = session.roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION'].includes(r));
  const coTheHoanHuy = session.roles.some((r) => ['OWNER', 'ADMIN'].includes(r));

  return (
    <>
      <PageHeader
        back={{ href: '/invoices', label: 'Danh sách hoá đơn' }}
        title={
          <span className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
            {inv.code}
            <Badge tone={nhan.tone} dot>
              {nhan.text}
            </Badge>
          </span>
        }
        sub={
          <>
            <Link className="link" href={`/members/${inv.memberId}`}>
              {inv.memberName}
            </Link>{' '}
            ({inv.memberCode}) · lập lúc {ngayGioVN(inv.issuedAt)}
          </>
        }
        actions={
          // Tải qua /api/proxy: token nằm ở cookie httpOnly, thẻ <a> thường
          // không gắn được Authorization. Proxy chuyển nguyên byte của PDF.
          <a href={`/api/proxy/invoices/${inv.id}/pdf`} target="_blank" rel="noopener" className="btn btn-secondary">
            <FileDown size={16} /> Tải PDF
          </a>
        }
      />

      <div className="stats">
        <StatCard label="Phải thu" value={vnd(inv.totalAmount)} unit="₫" icon={FileText} />
        <StatCard
          label="Đã thu"
          value={vnd(inv.paidAmount)}
          unit="₫"
          icon={Banknote}
          tone="success"
          meta={
            <span className="stack" style={{ gap: 6 }}>
              <span className="progress" style={{ height: 6 }}>
                <span style={{ width: `${tyLe}%`, background: 'var(--success)' }} />
              </span>
              {tyLe}% giá trị hoá đơn
            </span>
          }
        />
        <StatCard
          label="Còn lại"
          value={vnd(inv.outstanding)}
          unit="₫"
          icon={Wallet}
          tone={inv.outstanding > 0 ? 'danger' : undefined}
          meta={inv.outstanding > 0 ? 'chưa thu đủ' : 'đã tất toán'}
        />
      </div>

      {(coTheThu || coTheHoanHuy) && (
        <div className="mb-16">
          <InvoiceActions inv={inv} coTheThu={coTheThu} coTheHoanHuy={coTheHoanHuy} />
        </div>
      )}

      <Card flush title="Nội dung">
        <div className="table-wrap">
          <table className="table table-flush">
            <tbody>
              {inv.items.map((it) => (
                <tr key={it.id}>
                  <td>
                    <div className="cell-main">{it.description}</div>
                    {it.packageCode && <div className="cell-sub">Hợp đồng {it.packageCode}</div>}
                  </td>
                  <td className="num strong" style={{ width: 180 }}>
                    {vnd(it.amount)} ₫
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {inv.isInstallment && (
        <Card flush title="Kế hoạch trả góp" desc={`${inv.schedule.length} đợt`}>
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Đợt</th>
                  <th>Hạn</th>
                  <th className="num">Số tiền (₫)</th>
                  <th className="num">Đã thu (₫)</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {inv.schedule.map((s) => {
                  // "Quá hạn" tính bằng cách so ngày, không chờ trạng thái trong
                  // CSDL đổi: trạng thái chỉ được cập nhật khi có lần thu mới,
                  // nên một đợt vừa qua hạn hôm nay vẫn còn là DUE.
                  const quaHan = s.status !== 'PAID' && s.status !== 'WAIVED' && s.dueDate < homNay;
                  return (
                    <tr key={s.id}>
                      <td className="strong">#{s.seq}</td>
                      <td className={quaHan ? 'nowrap text-danger strong' : 'nowrap'}>
                        <span className="row-start" style={{ gap: 7 }}>
                          <CalendarClock size={15} className={quaHan ? undefined : 'faint'} />
                          {ngayISO(s.dueDate)}
                        </span>
                      </td>
                      <td className="num">{vnd(s.amount)}</td>
                      <td className="num">{vnd(s.paidAmount)}</td>
                      <td>
                        <Badge
                          tone={quaHan ? 'danger' : s.status === 'PAID' ? 'success' : s.status === 'WAIVED' ? 'neutral' : 'info'}
                          dot
                        >
                          {quaHan ? 'Quá hạn' : (TEN_DOT[s.status] ?? s.status)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        flush
        title="Lịch sử thu / hoàn tiền"
        footer={
          // Hoàn tiền là dòng RIÊNG mang dấu âm, không sửa dòng thu cũ — nói ra
          // để người đọc bảng hiểu vì sao tổng các dòng mới là số đã thu.
          inv.payments.some((p) => p.kind === 'REFUND') ? (
            <span className="row-start" style={{ gap: 7 }}>
              <Info size={14} />
              Khoản hoàn tiền được ghi thành dòng riêng mang dấu âm; dòng thu ban đầu giữ nguyên để lịch sử truy được.
            </span>
          ) : undefined
        }
      >
        {inv.payments.length === 0 ? (
          <EmptyState icon={History} title="Chưa có giao dịch" text="Chưa phát sinh lần thu hay hoàn tiền nào." />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Thời điểm</th>
                  <th>Loại</th>
                  <th>Hình thức</th>
                  <th className="num">Số tiền (₫)</th>
                  <th>Người thực hiện</th>
                  <th>Ghi chú</th>
                </tr>
              </thead>
              <tbody>
                {inv.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="nowrap">{ngayGioVN(p.paidAt)}</td>
                    <td>
                      {p.kind === 'REFUND' ? <Badge tone="danger">Hoàn tiền</Badge> : <Badge tone="success">Thu tiền</Badge>}
                    </td>
                    <td>{HINH_THUC_TT[p.method] ?? p.method}</td>
                    <td className={p.signedAmount < 0 ? 'num strong text-danger' : 'num strong'}>
                      {p.signedAmount > 0 ? '+' : ''}
                      {vnd(p.signedAmount)}
                    </td>
                    <td>{p.receivedByName ?? <span className="faint">—</span>}</td>
                    <td className="muted small">{p.note ?? p.reference ?? '—'}</td>
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
