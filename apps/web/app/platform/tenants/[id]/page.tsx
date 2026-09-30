import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Lock, Phone, PowerOff } from 'lucide-react';
import type { PlanInfo, PlatformTenantDetail } from '@pt/contracts';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader } from '../../../../components/ui';
import { UsageBar } from '../../../../components/saas';
import { ngayGioVN, ngayISO, ngayNgan, ngayVN, vnd } from '../../../../lib/format';
import { TRANG_THAI_HD_SAAS, TRANG_THAI_PHONG, TRANG_THAI_THUE_BAO } from '../../../../lib/labels';
import { apiFetch, duCap, requireSession } from '../../../../lib/session';
import { AuditTable } from '../../audit-table';
import { InvoiceActions } from '../../invoice-actions';
import { TenantActions } from './tenant-actions';

export const metadata: Metadata = { title: 'Chi tiết phòng tập' };

export default async function PlatformTenantPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const [t, plans] = await Promise.all([
    apiFetch<PlatformTenantDetail>(`/platform/tenants/${id}`, session),
    apiFetch<PlanInfo[]>('/platform/plans', session),
  ]);

  const ghi = duCap(session, 'OPS');
  const homNay = ngayVN();
  const dangMo = t.invoices.find((i) => i.status === 'PENDING');
  const st = TRANG_THAI_PHONG[t.status];

  return (
    <>
      <PageHeader
        back={{ href: '/platform/tenants', label: 'Phòng tập' }}
        title={
          <span className="row-start" style={{ gap: 10, flexWrap: 'wrap' }}>
            {t.name}
            <Badge tone={st?.tone} dot>
              {st?.text ?? t.status}
            </Badge>
          </span>
        }
        sub={
          <>
            <span className="mono">{t.slug}</span> · tạo ngày {ngayNgan(t.createdAt)} · múi giờ {t.timezone}
          </>
        }
      />

      {t.status === 'SUSPENDED' && (
        <div className="mb-16">
          <Alert tone="danger" icon={Lock}>
            <span>
              <strong>{t.suspendKind === 'MANUAL' ? 'Bị khoá tay' : 'Bị khoá do quá hạn thanh toán'}</strong>
              {t.statusNote ? ` — ${t.statusNote}` : ''}.{' '}
              {t.suspendKind === 'MANUAL'
                ? 'Trả tiền không tự mở khoá; phải bấm "Mở khoá".'
                : 'Xác nhận hoá đơn đang mở sẽ tự mở khoá.'}
            </span>
          </Alert>
        </div>
      )}
      {t.status === 'CLOSED' && (
        <div className="mb-16">
          <Alert tone="info" icon={PowerOff}>
            <span>Phòng đã đóng{t.statusNote ? ` — ${t.statusNote}` : ''}. Dữ liệu vẫn được giữ.</span>
          </Alert>
        </div>
      )}

      <div className="grid-cards mb-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}>
        <Card title="Thuê bao">
          <dl className="dl">
            <div>
              <dt>Gói</dt>
              <dd>{t.planName}</dd>
            </div>
            <div>
              <dt>Trạng thái</dt>
              <dd>
                <Badge tone={TRANG_THAI_THUE_BAO[t.subscriptionStatus]?.tone}>
                  {TRANG_THAI_THUE_BAO[t.subscriptionStatus]?.text ?? t.subscriptionStatus}
                </Badge>
              </dd>
            </div>
            <div>
              <dt>Kỳ hiện tại</dt>
              <dd className="tabular">
                {ngayISO(t.periodStart)} – {ngayISO(t.paidThrough)}
              </dd>
            </div>
            <div>
              <dt>{t.subscriptionStatus === 'TRIALING' ? 'Dùng thử tới hết' : 'Đã trả tới hết'}</dt>
              <dd className={t.paidThrough < homNay ? 'text-danger' : undefined}>{ngayISO(t.paidThrough)}</dd>
            </div>
            <div>
              <dt>Chờ thu</dt>
              <dd className="tabular">{t.openAmount > 0 ? `${vnd(t.openAmount)}đ` : '—'}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Sử dụng" desc="So với hạn mức của gói hiện tại.">
          <div className="stack" style={{ gap: 14 }}>
            <UsageBar label="Hội viên" m={t.usage.members} />
            <UsageBar label="Huấn luyện viên" m={t.usage.trainers} />
            <UsageBar label="Tin Zalo tháng này" m={t.usage.messages} />
          </div>
        </Card>

        <Card title="Chủ phòng">
          {t.owners.length === 0 ? (
            <p className="small muted">Chưa có chủ phòng.</p>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {t.owners.map((o) => (
                <div key={o.phone} className="cell-person">
                  <Avatar name={o.fullName} size="sm" />
                  <div>
                    <div className="cell-main">{o.fullName}</div>
                    <a href={`tel:${o.phone}`} className="cell-sub link row-start" style={{ gap: 4 }}>
                      <Phone size={12} /> {o.phone}
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {ghi && (
        <div className="mb-16">
          <Card title="Thao tác">
            <TenantActions
              tenantId={t.id}
              status={t.status}
              subscriptionStatus={t.subscriptionStatus}
              planCode={t.planCode}
              plans={plans}
              hasOpenInvoice={Boolean(dangMo)}
              canClose={duCap(session, 'SUPER')}
            />
          </Card>
        </div>
      )}

      {dangMo && (
        <div className="mb-16">
          <Card
            title="Hoá đơn đang mở"
            desc={`Kỳ ${ngayISO(dangMo.periodStart)} – ${ngayISO(dangMo.periodEnd)} · hạn ${ngayISO(dangMo.dueDate)}`}
          >
            <div className="stack" style={{ gap: 12 }}>
              <div className="ref-box">
                <span className="mono">{dangMo.transferRef}</span>
                <span className="strong tabular" style={{ fontSize: 18 }}>
                  {vnd(dangMo.amount)}đ
                </span>
              </div>
              {dangMo.note && <p className="small muted" style={{ margin: 0 }}>Ghi chú: {dangMo.note}</p>}
              {ghi && <InvoiceActions id={dangMo.id} amount={dangMo.amount} transferRef={dangMo.transferRef} />}
            </div>
          </Card>
        </div>
      )}

      <div className="mb-16">
        <Card title="Lịch sử hoá đơn" flush>
          {t.invoices.length === 0 ? (
            <EmptyState title="Chưa có hoá đơn" text="Hoá đơn đầu tiên tự phát hành 7 ngày trước khi hết kỳ hiện tại." />
          ) : (
            <div className="table-wrap">
              <table className="table table-flush">
                <thead>
                  <tr>
                    <th>Kỳ</th>
                    <th>Gói</th>
                    <th>Nội dung CK</th>
                    <th className="num">Số tiền</th>
                    <th>Trạng thái</th>
                    <th>Ghi chú</th>
                  </tr>
                </thead>
                <tbody>
                  {t.invoices.map((i) => (
                    <tr key={i.id} style={i.status === 'VOID' ? { opacity: 0.6 } : undefined}>
                      <td className="nowrap small">
                        {ngayISO(i.periodStart)} – {ngayISO(i.periodEnd)}
                      </td>
                      <td className="small">{i.planName}</td>
                      <td className="mono small">{i.transferRef}</td>
                      <td className="num tabular">{vnd(i.paidAmount ?? i.amount)}</td>
                      <td>
                        <Badge tone={TRANG_THAI_HD_SAAS[i.status]?.tone}>{TRANG_THAI_HD_SAAS[i.status]?.text ?? i.status}</Badge>
                        {i.confirmedAt && <div className="cell-sub">{ngayGioVN(i.confirmedAt)}</div>}
                      </td>
                      <td className="small muted">{i.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Nhật ký gần đây"
        flush
        actions={
          <Link href={`/platform/audit?tenantId=${t.id}`} className="btn btn-ghost btn-sm">
            Xem tất cả <ArrowRight size={14} />
          </Link>
        }
      >
        {t.audit.length === 0 ? <EmptyState title="Chưa có thao tác nào" /> : <AuditTable rows={t.audit} />}
      </Card>
    </>
  );
}
