import type { Metadata } from 'next';
import Link from 'next/link';
import { Banknote, Info } from 'lucide-react';
import type { BankTxnRow } from '@pt/contracts';
import { Alert, Badge, Card, EmptyState, PageHeader } from '../../../components/ui';
import { ngayGioVN, vnd } from '../../../lib/format';
import { KET_QUA_GD } from '../../../lib/labels';
import { apiFetch, duCap, requireSession } from '../../../lib/session';
import { BankResolve } from './bank-resolve';

export const metadata: Metadata = { title: 'Giao dịch ngân hàng' };

const LOC = [
  { key: 'OPEN', label: 'Cần xử lý' },
  { key: 'ALL', label: 'Tất cả' },
];

/**
 * Tiền vào tài khoản nhận (qua webhook SePay). Khớp đúng mã + đúng số tiền thì
 * hoá đơn tự tất toán; mọi trường hợp khác nằm ở tab "Cần xử lý" chờ người
 * xem — không có gì tự động đoán.
 */
export default async function BankTxns({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await requireSession();
  const { view } = await searchParams;
  const loc = view === 'ALL' ? 'ALL' : 'OPEN';
  const ghi = duCap(session, 'OPS');
  const rows = await apiFetch<BankTxnRow[]>(`/platform/bank-txns?view=${loc}`, session);
  const tong = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <>
      <PageHeader title="Giao dịch ngân hàng" sub={`${rows.length} giao dịch · ${vnd(tong)}đ`} />

      {loc === 'OPEN' && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>
              Đây là các khoản tiền vào mà hệ thống <strong>không tự khớp được</strong>. Xử lý xong ngoài đời (xác nhận tay ở{' '}
              <Link href="/platform/invoices" className="link">
                Đối soát thu tiền
              </Link>
              , hoàn tiền, hoặc bỏ qua) rồi bấm &ldquo;Đã xử lý&rdquo; và ghi lại đã làm gì.
            </span>
          </Alert>
        </div>
      )}

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc giao dịch">
            {LOC.map((l) => (
              <Link key={l.key} href={l.key === 'OPEN' ? '/platform/bank' : '/platform/bank?view=ALL'} aria-current={loc === l.key ? 'page' : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title={loc === 'OPEN' ? 'Không có giao dịch nào cần xử lý' : 'Chưa nhận giao dịch nào'}
            text={
              loc === 'OPEN'
                ? 'Mọi khoản tiền vào đều đã khớp hoá đơn hoặc đã có người xử lý.'
                : 'Chưa cấu hình webhook SePay, hoặc chưa có khoản chuyển khoản nào.'
            }
          />
        ) : (
          <div>
            {rows.map((r) => {
              const kq = KET_QUA_GD[r.outcome];
              return (
                <div key={r.id} className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div className="stack" style={{ gap: 4, minWidth: 0, flex: '1 1 280px' }}>
                      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <Badge tone={kq?.tone}>{kq?.text ?? r.outcome}</Badge>
                        {r.resolvedAt && <Badge tone="neutral">Đã xử lý</Badge>}
                        {r.tenantId && (
                          <Link href={`/platform/tenants/${r.tenantId}`} className="strong link">
                            {r.tenantName}
                          </Link>
                        )}
                      </div>
                      <div className="mono small" style={{ wordBreak: 'break-word' }}>
                        {r.content || '(không có nội dung)'}
                      </div>
                      <div className="meta-line">
                        <span>{ngayGioVN(r.txnAt ?? r.receivedAt)}</span>
                        <span className="mono">
                          {r.provider} #{r.providerTxnId}
                        </span>
                        {r.transferRef && (
                          <Link href={`/platform/invoices?status=ALL&q=${encodeURIComponent(r.transferRef)}`} className="link mono">
                            HĐ {r.transferRef}
                          </Link>
                        )}
                      </div>
                      {!r.resolvedAt && kq && r.outcome !== 'MATCHED' && <p className="small muted" style={{ margin: 0 }}>{kq.hint}</p>}
                      {r.resolvedAt && (
                        <div className="meta-line">
                          <span>
                            {r.resolvedByName ?? 'Hệ thống'} · {ngayGioVN(r.resolvedAt)}
                          </span>
                          {r.resolveNote && <span>{r.resolveNote}</span>}
                        </div>
                      )}
                    </div>
                    <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
                      <span className="strong tabular" style={{ fontSize: 18 }}>
                        {vnd(r.amount)}đ
                      </span>
                      {r.invoiceAmount !== null && r.invoiceAmount !== r.amount && (
                        <span className="small tabular text-warning">HĐ {vnd(r.invoiceAmount)}đ</span>
                      )}
                    </div>
                  </div>
                  {ghi && !r.resolvedAt && r.outcome !== 'MATCHED' && r.outcome !== 'IGNORED' && (
                    <div className="mt-8">
                      <BankResolve id={r.id} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
