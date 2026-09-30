import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, ArrowUpDown, Info, TriangleAlert } from 'lucide-react';
import type { PlatformPlanRequestRow } from '@pt/contracts';
import { Alert, Badge, Card, EmptyState, PageHeader } from '../../../components/ui';
import { ngayGioVN, vnd } from '../../../lib/format';
import { TRANG_THAI_YEU_CAU_GOI } from '../../../lib/labels';
import { apiFetch, duCap, requireSession } from '../../../lib/session';
import { PlanRequestActions } from './plan-request-actions';

export const metadata: Metadata = { title: 'Yêu cầu đổi gói' };

const LOC = [
  { key: 'PENDING', label: 'Chờ duyệt' },
  { key: 'APPROVED', label: 'Đã duyệt' },
  { key: 'REJECTED', label: 'Từ chối' },
  { key: 'CANCELLED', label: 'Đã huỷ' },
  { key: 'ALL', label: 'Tất cả' },
];

/**
 * Chủ phòng tự gửi yêu cầu ở Cài đặt → Gói dịch vụ; ở đây người vận hành
 * duyệt hoặc từ chối. Duyệt = đổi gói ngay (không tính chênh lệch kỳ này —
 * giá mới áp từ hoá đơn kỳ sau).
 */
export default async function PlanRequests({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const session = await requireSession();
  const { status } = await searchParams;
  const loc = LOC.some((l) => l.key === status) ? status! : 'PENDING';
  const ghi = duCap(session, 'OPS');

  const rows = await apiFetch<PlatformPlanRequestRow[]>(
    loc === 'ALL' ? '/platform/plan-requests' : `/platform/plan-requests?status=${loc}`,
    session,
  );

  return (
    <>
      <PageHeader title="Yêu cầu đổi gói" sub={`${rows.length} yêu cầu`} />

      {loc === 'PENDING' && rows.length > 0 && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>
              Duyệt là đổi gói <strong>ngay</strong>; giá mới áp từ hoá đơn kỳ sau, kỳ đang chạy không tính chênh lệch.
              Từ chối thì ghi lý do — chủ phòng sẽ thấy câu này ở trang Gói dịch vụ.
            </span>
          </Alert>
        </div>
      )}

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc theo trạng thái">
            {LOC.map((l) => (
              <Link
                key={l.key}
                href={l.key === 'PENDING' ? '/platform/plan-requests' : `/platform/plan-requests?status=${l.key}`}
                aria-current={loc === l.key ? 'page' : undefined}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={ArrowUpDown}
            title={loc === 'PENDING' ? 'Không có yêu cầu nào chờ duyệt' : 'Không có yêu cầu nào'}
            text={loc === 'PENDING' ? 'Khi chủ phòng xin nâng hay hạ gói, yêu cầu sẽ hiện ở đây.' : 'Không có yêu cầu nào ở trạng thái này.'}
          />
        ) : (
          <div>
            {rows.map((r) => {
              const tang = r.toPrice > r.fromPrice;
              const tt = TRANG_THAI_YEU_CAU_GOI[r.status];
              return (
                <div key={r.id} className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                    <div className="stack" style={{ gap: 4, minWidth: 0 }}>
                      <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <Link href={`/platform/tenants/${r.tenantId}`} className="strong link">
                          {r.tenantName}
                        </Link>
                        <Badge tone={tt?.tone}>{tt?.text ?? r.status}</Badge>
                        {r.status === 'PENDING' && <Badge tone={tang ? 'success' : 'neutral'}>{tang ? 'Nâng gói' : 'Hạ gói'}</Badge>}
                      </div>
                      <div className="meta-line">
                        <span>
                          {r.requestedByName} · {ngayGioVN(r.createdAt)}
                        </span>
                        {r.note && <span>&ldquo;{r.note}&rdquo;</span>}
                      </div>
                      {r.decidedAt && (
                        <div className="meta-line">
                          <span>
                            {r.status === 'CANCELLED' ? 'Chủ phòng huỷ' : `${r.decidedByName ?? 'Hệ thống'} xử lý`} ·{' '}
                            {ngayGioVN(r.decidedAt)}
                          </span>
                          {r.decisionNote && <span>{r.decisionNote}</span>}
                        </div>
                      )}
                    </div>
                    <div className="row-start" style={{ gap: 10, alignItems: 'center' }}>
                      <div className="stack" style={{ gap: 0, alignItems: 'flex-end' }}>
                        <span className="small muted">{r.fromPlanName}</span>
                        <span className="small tabular muted">{vnd(r.fromPrice)}đ</span>
                      </div>
                      <ArrowRight size={16} className="muted" />
                      <div className="stack" style={{ gap: 0 }}>
                        <span className="strong">{r.toPlanName}</span>
                        <span className="small tabular">{vnd(r.toPrice)}đ/tháng</span>
                      </div>
                    </div>
                  </div>

                  {r.overLimit.length > 0 && (
                    <div className="mt-8">
                      <Alert tone="warning" icon={TriangleAlert}>
                        <span>
                          Phòng đang vượt hạn mức gói {r.toPlanName}: <strong>{r.overLimit.join(', ')}</strong>. Duyệt vẫn
                          được — người đang có không bị ảnh hưởng — nhưng phòng sẽ không tạo thêm được tới khi giảm dưới
                          hạn mức.
                        </span>
                      </Alert>
                    </div>
                  )}

                  {ghi && r.status === 'PENDING' && (
                    <div className="mt-8">
                      <PlanRequestActions id={r.id} toPlanName={r.toPlanName} />
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
