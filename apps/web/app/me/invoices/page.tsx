import { CalendarClock, CircleCheck, Download, Receipt, Wallet } from 'lucide-react';
import type { MyInvoice } from '@pt/contracts';
import { Badge, EmptyState, type Tone } from '../../../components/ui';
import { ngayISO, ngayNgan, ngayVN, vnd } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

const NHAN: Record<string, { text: string; tone: Tone }> = {
  OPEN: { text: 'Chưa thanh toán', tone: 'info' },
  PARTIALLY_PAID: { text: 'Thanh toán một phần', tone: 'warning' },
  PAID: { text: 'Đã thanh toán đủ', tone: 'success' },
  VOID: { text: 'Đã huỷ', tone: 'neutral' },
  REFUNDED: { text: 'Đã hoàn tiền', tone: 'neutral' },
};

export default async function MeInvoices() {
  const session = await requireSession();
  const rows = await apiFetch<MyInvoice[]>('/me/invoices', session);
  const tongNo = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  const homNay = ngayVN();

  return (
    <>
      <h1 className="m-title">Hoá đơn</h1>
      <p className="m-sub">Các khoản thanh toán cho gói tập của bạn.</p>

      <div className="mt-16">
        {tongNo > 0 ? (
          <div className="alert" data-tone="warning">
            <Wallet size={17} />
            <div className="alert-body">
              <span>
                Còn phải thanh toán tổng cộng <strong>{vnd(tongNo)} ₫</strong>
              </span>
            </div>
          </div>
        ) : (
          <div className="alert" data-tone="success">
            <CircleCheck size={17} />
            <div className="alert-body">Bạn không còn khoản nào phải thanh toán.</div>
          </div>
        )}
      </div>

      <h2 className="m-section">Danh sách</h2>
      {rows.length === 0 ? (
        <div className="card">
          <EmptyState icon={Receipt} title="Chưa có hoá đơn nào" />
        </div>
      ) : (
        <div className="stack">
          {rows.map((r) => {
            const quaHan = r.nextDueDate != null && r.nextDueDate < homNay;
            const nhan = NHAN[r.status] ?? { text: r.status, tone: 'neutral' as const };
            return (
              <article key={r.id} className="card list-card">
                <div className="row">
                  <div className="row-start">
                    <span className="icon-tile">
                      <Receipt size={19} />
                    </span>
                    <div>
                      <div className="strong">{r.code}</div>
                      <div className="cell-sub">{ngayNgan(r.issuedAt)}</div>
                    </div>
                  </div>
                  <Badge tone={nhan.tone}>{nhan.text}</Badge>
                </div>

                <dl className="dl">
                  <div>
                    <dt>Tổng tiền</dt>
                    <dd>{vnd(r.totalAmount)} ₫</dd>
                  </div>
                  <div>
                    <dt>Đã thanh toán</dt>
                    <dd>{vnd(r.paidAmount)} ₫</dd>
                  </div>
                  {r.outstanding > 0 && (
                    <div>
                      <dt>Còn lại</dt>
                      <dd className="text-warning strong">{vnd(r.outstanding)} ₫</dd>
                    </div>
                  )}
                </dl>

                {/* Đợt trả góp tới hạn là thứ hội viên cần thấy rõ nhất — quá hạn
                    thì tô đỏ, không để họ phải tự so ngày. */}
                {r.isInstallment && r.nextDueDate && (
                  <div className="alert" data-tone={quaHan ? 'danger' : 'info'}>
                    <CalendarClock size={17} />
                    <div className="alert-body">
                      <span>
                        <strong>{quaHan ? 'Quá hạn' : 'Đợt tới'}:</strong> {vnd(r.nextDueAmount ?? 0)} ₫ · hạn{' '}
                        {ngayISO(r.nextDueDate)}
                      </span>
                    </div>
                  </div>
                )}

                {/* Qua proxy để gửi kèm phiên đăng nhập; API chỉ trả hoá đơn của chính hội viên. */}
                <a href={`/api/proxy/invoices/${r.id}/pdf`} target="_blank" rel="noopener" className="btn btn-ghost btn-sm" style={{ alignSelf: 'flex-start' }}>
                  <Download size={14} /> Tải hoá đơn PDF
                </a>
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
