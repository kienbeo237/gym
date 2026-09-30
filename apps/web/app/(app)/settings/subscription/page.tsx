import type { Metadata } from 'next';
import { ArrowUpDown, Check, CircleCheck, CircleHelp, CircleX, Landmark, Lock, Sparkles, TriangleAlert } from 'lucide-react';
import type { SubscriptionOverview } from '@pt/contracts';
import { Alert, Badge, Card, EmptyState, PageHeader } from '../../../../components/ui';
import { CopyButton } from '../../../../components/copy-button';
import { UsageBar, hanMuc } from '../../../../components/saas';
import { ngayGioVN, ngayISO, vnd } from '../../../../lib/format';
import { TRANG_THAI_HD_SAAS, TRANG_THAI_THUE_BAO } from '../../../../lib/labels';
import { CancelPlanRequest, PlanRequestButton } from './plan-request';
import { apiFetch, requireSession } from '../../../../lib/session';

export const metadata: Metadata = { title: 'Gói dịch vụ' };

/**
 * Chủ phòng xem gói, mức dùng, và CÁCH TRẢ TIỀN cho nền tảng.
 *
 * Trả bằng chuyển khoản thủ công: nội dung chuyển khoản là khoá đối soát duy
 * nhất, nên nó được hiện to, có nút chép, và nhắc ghi ĐÚNG nguyên văn.
 */
export default async function SubscriptionPage() {
  const session = await requireSession();
  const s = await apiFetch<SubscriptionOverview>('/subscription', session);
  const hd = s.invoices.find((i) => i.status === 'PENDING');
  const lienHe = s.supportContact ? ` qua ${s.supportContact}` : '';
  const laChu = session.roles.includes('OWNER');
  const yc = s.planRequest;
  const dangCho = yc?.status === 'PENDING';
  const giaHienTai = s.plans.find((p) => p.code === s.planCode)?.priceMonthly ?? 0;
  /** Gói đích chật hơn số đang có -> API từ chối (PLAN_TOO_SMALL); báo trước ở thẻ gói. */
  const chat = (max: number | null, used: number, don: string) => (max !== null && used > max ? `đang có ${used} ${don}` : null);

  return (
    <>
      <PageHeader
        title="Gói dịch vụ"
        sub={
          <>
            Gói <strong>{s.planName}</strong> · {TRANG_THAI_THUE_BAO[s.subscriptionStatus]?.text ?? s.subscriptionStatus} ·{' '}
            {s.subscriptionStatus === 'TRIALING' ? 'dùng thử tới hết' : 'đã trả tới hết'} ngày {ngayISO(s.paidThrough)}
          </>
        }
      />

      {s.tenantStatus === 'SUSPENDED' && (
        <div className="mb-16">
          <Alert tone="danger" icon={Lock}>
            <span>
              <strong>Phòng đang bị tạm khoá{s.statusNote ? ` — ${s.statusNote}` : ''}.</strong>{' '}
              {hd
                ? 'Phòng tự mở lại ngay khi khoản chuyển khoản dưới đây được xác nhận.'
                : `Liên hệ bộ phận hỗ trợ${lienHe} để mở khoá.`}
            </span>
          </Alert>
        </div>
      )}
      {s.tenantStatus === 'PAST_DUE' && s.suspendOn && (
        <div className="mb-16">
          <Alert tone="warning" icon={TriangleAlert}>
            <span>
              Gói đã hết hạn. Phòng vẫn dùng bình thường tới hết ngày {ngayISO(s.suspendOn)} ({s.graceDays} ngày ân hạn);
              sau đó chuyển sang chỉ xem cho tới khi thanh toán.
            </span>
          </Alert>
        </div>
      )}

      {yc && (
        <div className="mb-16">
          {yc.status === 'PENDING' ? (
            <Alert tone="info" icon={ArrowUpDown}>
              <span>
                Đã gửi yêu cầu chuyển sang gói <strong>{yc.toPlanName}</strong> lúc {ngayGioVN(yc.createdAt)} — đang chờ PT Studio
                duyệt. Gói mới có hiệu lực ngay khi được duyệt; giá mới tính từ hoá đơn kỳ sau.
                {laChu && (
                  <>
                    {' '}
                    <CancelPlanRequest />
                  </>
                )}
              </span>
            </Alert>
          ) : yc.status === 'APPROVED' ? (
            <Alert tone="success" icon={CircleCheck}>
              <span>
                Yêu cầu chuyển sang gói <strong>{yc.toPlanName}</strong> đã được duyệt
                {yc.decidedAt ? ` lúc ${ngayGioVN(yc.decidedAt)}` : ''}.{yc.decisionNote ? ` Ghi chú: ${yc.decisionNote}` : ''}
              </span>
            </Alert>
          ) : (
            <Alert tone="warning" icon={CircleX}>
              <span>
                Yêu cầu chuyển sang gói <strong>{yc.toPlanName}</strong> không được duyệt
                {yc.decisionNote ? `: ${yc.decisionNote}` : '.'} Bạn có thể gửi yêu cầu khác bên dưới.
              </span>
            </Alert>
          )}
        </div>
      )}

      {hd && (
        <div className="mb-16">
          <Card
            title="Thanh toán kỳ tới"
            desc={`Kỳ ${ngayISO(hd.periodStart)} – ${ngayISO(hd.periodEnd)} · gói ${hd.planName} · hạn ${ngayISO(hd.dueDate)}`}
          >
            <div className="stack" style={{ gap: 14 }}>
              <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
                <span className="muted small">Số tiền</span>
                <span className="strong tabular" style={{ fontSize: 24 }}>
                  {vnd(hd.amount)}đ
                </span>
              </div>
              {s.payTo ? (
                <dl className="dl">
                  <div>
                    <dt>Ngân hàng</dt>
                    <dd>{s.payTo.bankName}</dd>
                  </div>
                  <div>
                    <dt>Số tài khoản</dt>
                    <dd className="row-start" style={{ gap: 8, justifyContent: 'flex-end' }}>
                      <span className="mono">{s.payTo.accountNo}</span>
                      <CopyButton text={s.payTo.accountNo} />
                    </dd>
                  </div>
                  <div>
                    <dt>Chủ tài khoản</dt>
                    <dd>{s.payTo.accountName}</dd>
                  </div>
                </dl>
              ) : (
                <Alert tone="info" icon={Landmark}>
                  <span>Liên hệ bộ phận hỗ trợ{lienHe} để nhận thông tin tài khoản.</span>
                </Alert>
              )}
              <div className="stack" style={{ gap: 6 }}>
                <span className="field-label">Nội dung chuyển khoản — ghi ĐÚNG nguyên văn</span>
                <div className="ref-box">
                  <span className="mono">{hd.transferRef}</span>
                  <CopyButton text={hd.transferRef} label="Chép nội dung" />
                </div>
                <span className="field-hint">
                  Nội dung này là cách duy nhất để nhận ra khoản tiền của phòng bạn. Gói được gia hạn sau khi khoản tiền được
                  đối soát (thường trong ngày làm việc).
                </span>
              </div>
            </div>
          </Card>
        </div>
      )}

      <div className="grid-cards mb-16" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))' }}>
        <Card title="Mức sử dụng" desc="Hội viên và HLV tính số đang có; tin Zalo tính trong tháng này.">
          <div className="stack" style={{ gap: 14 }}>
            <UsageBar label="Hội viên" m={s.usage.members} />
            <UsageBar label="Huấn luyện viên" m={s.usage.trainers} />
            <UsageBar label="Tin Zalo tháng này" m={s.usage.messages} />
            {s.usage.messages.limit !== null && s.usage.messages.used >= s.usage.messages.limit && (
              <p className="small text-danger" style={{ margin: 0 }}>
                Đã hết hạn mức tin tháng này: tin nhắc lịch và chiến dịch tạm dừng tới đầu tháng sau (mã OTP đăng nhập vẫn
                gửi). Nâng gói để gửi tiếp.
              </p>
            )}
          </div>
        </Card>

        <Card title="Thuê bao">
          <dl className="dl">
            <div>
              <dt>Gói hiện tại</dt>
              <dd>{s.planName}</dd>
            </div>
            <div>
              <dt>Kỳ hiện tại</dt>
              <dd className="tabular">
                {ngayISO(s.periodStart)} – {ngayISO(s.paidThrough)}
              </dd>
            </div>
            {s.trialEndsAt && s.subscriptionStatus === 'TRIALING' && (
              <div>
                <dt>Hết dùng thử</dt>
                <dd>{ngayISO(s.paidThrough)}</dd>
              </div>
            )}
            <div>
              <dt>Ân hạn sau khi hết kỳ</dt>
              <dd>{s.graceDays} ngày</dd>
            </div>
          </dl>
          <p className="small muted row-start mt-16" style={{ gap: 6, marginBottom: 0 }}>
            <CircleHelp size={14} /> Hoá đơn kỳ tới được phát hành 7 ngày trước khi hết kỳ.
          </p>
        </Card>
      </div>

      <h2 className="card-title mb-16" style={{ marginTop: 8 }}>
        Các gói
      </h2>
      <div className="grid-cards mb-16">
        {s.plans.map((p) => {
          const dangDung = p.code === s.planCode;
          const daYeuCau = dangCho && yc?.toPlan === p.code;
          const vuot = [chat(p.maxMembers, s.usage.members.used, 'hội viên'), chat(p.maxTrainers, s.usage.trainers.used, 'HLV')].filter(
            (x): x is string => x !== null,
          );
          return (
            <article key={p.code} className="card pkg" data-current={dangDung}>
              <div className="pkg-head">
                <h3 className="pkg-name">{p.name}</h3>
                {dangDung && <Badge tone="primary">Đang dùng</Badge>}
                {daYeuCau && <Badge tone="warning">Đã yêu cầu</Badge>}
              </div>
              <div className="pkg-price">
                <strong>{p.priceMonthly > 0 ? `${vnd(p.priceMonthly)} ₫` : 'Miễn phí'}</strong>
                {p.priceMonthly > 0 && <span className="muted small">/ tháng</span>}
              </div>
              <ul className="stack small" style={{ gap: 8, listStyle: 'none', padding: 0, margin: 0 }}>
                {[hanMuc(p.maxMembers, 'hội viên'), hanMuc(p.maxTrainers, 'huấn luyện viên'), `${hanMuc(p.maxMessagesMonth, 'tin Zalo')} / tháng`].map(
                  (x) => (
                    <li key={x} className="row-start" style={{ gap: 8 }}>
                      <Check size={15} className="text-success" /> {x}
                    </li>
                  ),
                )}
              </ul>
              {laChu && !dangDung && !dangCho && (
                <div className="mt-16">
                  {vuot.length > 0 ? (
                    <p className="small muted" style={{ margin: 0 }}>
                      Chưa chuyển được: phòng {vuot.join(', ')} — vượt hạn mức gói này.
                    </p>
                  ) : (
                    <PlanRequestButton planCode={p.code} planName={p.name} upgrade={p.priceMonthly > giaHienTai} />
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
      <p className="small muted row-start mb-24" style={{ gap: 6 }}>
        <Sparkles size={14} />{' '}
        {laChu
          ? 'Chọn gói ở trên để gửi yêu cầu đổi gói. PT Studio duyệt xong thì hạn mức mới có hiệu lực ngay; giá mới tính từ kỳ sau.'
          : 'Chỉ chủ phòng gửi được yêu cầu đổi gói.'}
      </p>

      <Card title="Lịch sử hoá đơn" flush>
        {s.invoices.length === 0 ? (
          <EmptyState title="Chưa có hoá đơn" text="Hoá đơn đầu tiên được phát hành 7 ngày trước khi hết kỳ hiện tại." />
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
                </tr>
              </thead>
              <tbody>
                {s.invoices.map((i) => (
                  <tr key={i.id}>
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
