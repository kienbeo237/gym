import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  ArrowUpDown,
  Banknote,
  Building2,
  CircleCheck,
  Clock,
  Landmark,
  MessageSquareText,
  Scale,
  TrendingUp,
} from 'lucide-react';
import type { PlatformInvoiceRow, PlatformOverview, PlatformTenantRow } from '@pt/contracts';
import { Alert, Badge, Card, EmptyState, PageHeader, StatCard } from '../../components/ui';
import { UsageBar } from '../../components/saas';
import { ngayGioVN, ngayISO, ngayVN, vnd, vndGon } from '../../lib/format';
import { TRANG_THAI_PHONG, VIEW_DOI_SOAT } from '../../lib/labels';
import { apiFetch, requireSession } from '../../lib/session';

export const metadata: Metadata = { title: 'Tổng quan nền tảng' };

const THU_TU_TRANG_THAI = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED'];

/** Có thanh hạn mức nào từ 80% trở lên không. */
const sapCham = (t: PlatformTenantRow) =>
  Object.values(t.usage).some((m) => m.limit !== null && m.limit > 0 && m.used / m.limit >= 0.8);

/**
 * Màn mở đầu mỗi sáng của người đối soát: bao nhiêu tiền đang chờ, phòng nào
 * sắp bị khoá, phòng nào sắp chạm trần gói (cơ hội nâng gói).
 */
export default async function PlatformHome() {
  const session = await requireSession();
  const [o, cho, phong] = await Promise.all([
    apiFetch<PlatformOverview>('/platform/overview', session),
    apiFetch<PlatformInvoiceRow[]>('/platform/invoices?status=PENDING', session),
    apiFetch<PlatformTenantRow[]>('/platform/tenants', session),
  ]);

  const homNay = ngayVN();
  const tongPhong = Object.values(o.tenantsByStatus).reduce((s, n) => s + n, 0);
  const canChuY = phong.filter((t) => t.status === 'PAST_DUE' || t.status === 'SUSPENDED');
  const sapHetHanMuc = phong.filter((t) => t.status !== 'CLOSED' && sapCham(t));

  return (
    <>
      <PageHeader title="Tổng quan nền tảng" sub={`${tongPhong} phòng tập · hôm nay ${ngayISO(homNay)}`} />

      <div className="stats">
        <StatCard label="Doanh thu định kỳ / tháng" value={vndGon(o.mrr)} unit="₫" icon={TrendingUp} meta="giá gói của các phòng đang trả phí" />
        <StatCard
          label="Chờ thanh toán"
          value={vndGon(o.openInvoices.amount)}
          unit="₫"
          icon={Landmark}
          tone={o.openInvoices.overdue > 0 ? 'danger' : o.openInvoices.count > 0 ? 'warning' : undefined}
          meta={
            o.openInvoices.count === 0
              ? 'không có hoá đơn nào đang mở'
              : `${o.openInvoices.count} hoá đơn${o.openInvoices.overdue > 0 ? `, ${o.openInvoices.overdue} quá hạn` : ''}`
          }
        />
        <StatCard label="Đã thu tháng này" value={vndGon(o.paidThisMonth)} unit="₫" icon={CircleCheck} tone="success" meta="theo ngày xác nhận" />
        <StatCard label="Tin Zalo tháng này" value={o.messagesThisMonth.toLocaleString('vi-VN')} unit="tin" icon={MessageSquareText} meta="toàn nền tảng, tính vào hạn mức" />
      </div>

      <DoiSoat r={o.reconciliation} />

      {(o.unmatchedBankTxns > 0 || o.pendingPlanRequests > 0) && (
        <div className="stack mb-16" style={{ gap: 8 }}>
          {o.unmatchedBankTxns > 0 && (
            <Alert tone="warning" icon={Banknote}>
              <span>
                <strong>{o.unmatchedBankTxns} khoản tiền vào chưa khớp</strong> được hoá đơn nào (lệch số tiền, chuyển trùng,
                sai nội dung).{' '}
                <Link href="/platform/bank" className="link">
                  Xem và xử lý
                </Link>
              </span>
            </Alert>
          )}
          {o.pendingPlanRequests > 0 && (
            <Alert tone="info" icon={ArrowUpDown}>
              <span>
                <strong>{o.pendingPlanRequests} yêu cầu đổi gói</strong> đang chờ duyệt.{' '}
                <Link href="/platform/plan-requests" className="link">
                  Mở hàng chờ
                </Link>
              </span>
            </Alert>
          )}
        </div>
      )}

      <div className="row-start mb-24" style={{ gap: 8, flexWrap: 'wrap' }}>
        {THU_TU_TRANG_THAI.filter((s) => o.tenantsByStatus[s]).map((s) => (
          <Link key={s} href={`/platform/tenants?status=${s}`}>
            <Badge tone={TRANG_THAI_PHONG[s]?.tone} dot>
              {TRANG_THAI_PHONG[s]?.text ?? s}: {o.tenantsByStatus[s]}
            </Badge>
          </Link>
        ))}
      </div>

      <div className="grid-cards" style={{ alignItems: "start", gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))' }}>
        <Card
          title="Hoá đơn chờ đối soát"
          desc="Hạn gần nhất lên đầu. Đối chiếu nội dung chuyển khoản với sao kê."
          flush
          actions={
            <Link href="/platform/invoices" className="btn btn-ghost btn-sm">
              Mở hàng đối soát <ArrowRight size={14} />
            </Link>
          }
        >
          {cho.length === 0 ? (
            <EmptyState icon={Landmark} title="Không có hoá đơn nào chờ" text="Mọi phòng đã thanh toán kỳ hiện tại." />
          ) : (
            <div className="table-wrap">
              <table className="table table-flush">
                <thead>
                  <tr>
                    <th>Phòng tập</th>
                    <th>Nội dung CK</th>
                    <th className="num">Số tiền</th>
                    <th>Hạn</th>
                  </tr>
                </thead>
                <tbody>
                  {cho.slice(0, 8).map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={`/platform/tenants/${i.tenantId}`} className="cell-main link">
                          {i.tenantName}
                        </Link>
                      </td>
                      <td className="mono small">{i.transferRef}</td>
                      <td className="num tabular">{vnd(i.amount)}</td>
                      <td className={i.dueDate < homNay ? 'text-danger nowrap' : 'nowrap'}>{ngayISO(i.dueDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="stack" style={{ gap: 16 }}>
          <Card title="Phòng cần chú ý" desc="Quá hạn thanh toán hoặc đang bị khoá." flush>
            {canChuY.length === 0 ? (
              <EmptyState icon={Building2} title="Không có phòng nào" text="Không phòng nào quá hạn hay bị khoá." />
            ) : (
              <div className="table-wrap">
                <table className="table table-flush">
                  <tbody>
                    {canChuY.map((t) => (
                      <tr key={t.id}>
                        <td>
                          <Link href={`/platform/tenants/${t.id}`} className="cell-main link">
                            {t.name}
                          </Link>
                          <div className="cell-sub">
                            Đã trả tới {ngayISO(t.paidThrough)}
                            {t.statusNote ? ` · ${t.statusNote}` : ''}
                          </div>
                        </td>
                        <td className="num">
                          <Badge tone={TRANG_THAI_PHONG[t.status]?.tone}>{TRANG_THAI_PHONG[t.status]?.text ?? t.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="Sắp chạm hạn mức gói" desc="Từ 80% một hạn mức trở lên — cơ hội nâng gói.">
            {sapHetHanMuc.length === 0 ? (
              <p className="small muted">Chưa phòng nào dùng tới 80% hạn mức.</p>
            ) : (
              <div className="stack" style={{ gap: 14 }}>
                {sapHetHanMuc.map((t) => (
                  <div key={t.id} className="stack" style={{ gap: 8 }}>
                    <div className="row">
                      <Link href={`/platform/tenants/${t.id}`} className="strong link">
                        {t.name}
                      </Link>
                      <Badge>{t.planName}</Badge>
                    </div>
                    <div className="usage-cell">
                      <UsageBar compact label="Hội viên" m={t.usage.members} />
                      <UsageBar compact label="HLV" m={t.usage.trainers} />
                      <UsageBar compact label="Tin/tháng" m={t.usage.messages} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

/** Job đối soát chạy 6 giờ một lần; quá hai lượt mà chưa có kết quả mới thì worker có thể đã dừng. */
const DOI_SOAT_CU_MS = 13 * 3600_000;

/**
 * Đối soát định kỳ. Lệch là LỖI HỆ THỐNG (không phải việc của phòng tập) —
 * nên báo đỏ ở đầu trang, kèm tên view để kỹ sư biết tìm ở đâu. Không lệch
 * thì chỉ một dòng mờ: đủ để biết job còn chạy.
 */
function DoiSoat({ r }: { r: PlatformOverview['reconciliation'] }) {
  if (!r) {
    return (
      <div className="mb-16">
        <Alert tone="info" icon={Scale}>
          <span>Đối soát dữ liệu chưa chạy lần nào. Worker chạy nó 6 giờ một lần — kiểm tra worker đã khởi động chưa.</span>
        </Alert>
      </div>
    );
  }
  const lech = Object.entries(r.counts).filter(([, n]) => n > 0);
  const loi = Object.entries(r.errors);
  const cu = Date.now() - new Date(r.ranAt).getTime() > DOI_SOAT_CU_MS;

  if (lech.length === 0 && loi.length === 0) {
    return cu ? (
      <div className="mb-16">
        <Alert tone="warning" icon={Clock}>
          <span>
            Lần đối soát gần nhất là <strong>{ngayGioVN(r.ranAt)}</strong> — đã quá hai lượt chạy. Worker có thể đã dừng.
          </span>
        </Alert>
      </div>
    ) : (
      <p className="small muted mb-16 row-start" style={{ gap: 6 }}>
        <Scale size={14} /> Đối soát lúc {ngayGioVN(r.ranAt)}: tám phép kiểm đều khớp.
      </p>
    );
  }

  return (
    <div className="mb-16">
      <Alert tone="danger" icon={Scale}>
        <span>
          <strong>Đối soát dữ liệu phát hiện lệch</strong> ({ngayGioVN(r.ranAt)}). Đây là lỗi hệ thống — báo kỹ sư, đừng sửa
          tay số liệu của phòng tập.
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {lech.map(([v, n]) => (
              <li key={v}>
                {VIEW_DOI_SOAT[v] ?? v}: <strong className="tabular">{n}</strong> dòng <code className="faint">{v}</code>
              </li>
            ))}
            {loi.map(([v, e]) => (
              <li key={v}>
                Không chạy được <code>{v}</code>: <span className="faint">{e}</span>
              </li>
            ))}
          </ul>
        </span>
      </Alert>
    </div>
  );
}
