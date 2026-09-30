import type { Metadata } from 'next';
import { CircleCheck, Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { ZaloOaInfo, ZnsTemplateRow } from '@pt/contracts';
import { Alert, Badge, Card, PageHeader } from '../../../../components/ui';
import { ngayGioVN } from '../../../../lib/format';
import { TRANG_THAI_OA } from '../../../../lib/labels';
import { apiFetch, requireSession } from '../../../../lib/session';
import { ConnectButtons, CopyText, CredentialsForm, TemplateTable, WebhookForm } from './zalo-panels';

export const metadata: Metadata = { title: 'Zalo OA' };

/**
 * Mỗi phòng tập gửi tin bằng Zalo OA CỦA CHÍNH MÌNH: hội viên thấy tên phòng
 * tập, không thấy tên nền tảng. Nên mỗi phòng tự khai ứng dụng, tự cấp quyền,
 * tự đăng ký mẫu ZNS — màn này dẫn họ đi đúng ba bước đó.
 */
export default async function ZaloSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ ketnoi?: string }>;
}) {
  const session = await requireSession();
  const { ketnoi } = await searchParams;
  const [info, templates] = await Promise.all([
    apiFetch<ZaloOaInfo>('/zalo/oa', session),
    apiFetch<ZnsTemplateRow[]>('/zalo/templates', session),
  ]);

  const nhan = TRANG_THAI_OA[info.status] ?? { text: info.status, tone: 'neutral' as const };
  const soDaDuyet = templates.filter((t) => t.status === 'APPROVED').length;

  return (
    <>
      <PageHeader
        title="Zalo Official Account"
        sub="Gửi tin chăm sóc hội viên bằng OA mang tên phòng tập của bạn"
        actions={
          <Badge tone={nhan.tone} dot>
            {nhan.text}
          </Badge>
        }
      />

      {info.driver === 'log' && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>
              Môi trường thử nghiệm: hệ thống <b>không gọi Zalo thật</b>. Kết nối được mô phỏng và mọi tin chỉ ghi
              ra nhật ký của worker.
            </span>
          </Alert>
        </div>
      )}
      {ketnoi === 'ok' && info.status === 'CONNECTED' && (
        <div className="mb-16">
          <Alert tone="success" icon={CircleCheck}>
            Đã kết nối Zalo OA. Bước cuối: khai mã các mẫu tin đã được Zalo duyệt ở bảng bên dưới.
          </Alert>
        </div>
      )}
      {(info.status === 'TOKEN_EXPIRED' || info.status === 'ERROR') && (
        <div className="mb-16">
          <Alert tone="danger" icon={TriangleAlert}>
            {info.status === 'TOKEN_EXPIRED'
              ? 'Phiên kết nối đã hết hạn hoặc bị thu hồi — tin Zalo đang ngừng gửi. Bấm "Kết nối lại" để cấp quyền lần nữa.'
              : 'Kết nối Zalo gặp lỗi.'}
            {info.lastError && <div className="small mt-4">Chi tiết: {info.lastError}</div>}
          </Alert>
        </div>
      )}

      <div className="stack" style={{ gap: 20 }}>
        <Card
          title="1. Khoá ứng dụng Zalo"
          desc="Lấy tại developers.zalo.me → ứng dụng của bạn → Thông tin ứng dụng."
        >
          <CredentialsForm info={info} />
          <div className="row-start small muted mt-16" style={{ gap: 6 }}>
            <ShieldCheck size={14} /> Secret key được mã hoá riêng cho phòng tập của bạn và không bao giờ hiển thị lại.
          </div>
        </Card>

        <Card title="2. Cấp quyền cho OA" desc="Chủ OA đăng nhập Zalo và đồng ý cho ứng dụng gửi tin thay mặt OA.">
          <div className="stack" style={{ gap: 16 }}>
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>Callback URL — khai ở mục “Official Account → Thiết lập chung”</div>
              <CopyText text={info.redirectUri} />
            </div>
            {info.status !== 'DISCONNECTED' && (
              <dl className="dl" style={{ maxWidth: 480 }}>
                <div>
                  <dt>OA ID</dt>
                  <dd className="tabular">{info.oaId ?? '—'}</dd>
                </div>
                <div>
                  <dt>Kết nối lúc</dt>
                  <dd>{info.connectedAt ? ngayGioVN(info.connectedAt) : '—'}</dd>
                </div>
                <div>
                  <dt>Phiên hết hạn (tự gia hạn)</dt>
                  <dd>{info.tokenExpiresAt ? ngayGioVN(info.tokenExpiresAt) : '—'}</dd>
                </div>
              </dl>
            )}
            <ConnectButtons info={info} />
          </div>
        </Card>

        <Card
          flush
          title="3. Mẫu tin ZNS"
          desc={
            <>
              Đăng ký từng mẫu trên ZNS của OA, chờ Zalo duyệt, rồi dán <b>mã template</b> vào đây. Mẫu chưa duyệt thì
              tin loại đó được bỏ qua, không gửi. Đã duyệt {soDaDuyet}/{templates.length} mẫu.
            </>
          }
        >
          <TemplateTable rows={templates} />
        </Card>

        <Card
          title={
            <span className="row-start" style={{ gap: 10 }}>
              4. Báo phát <span className="faint small" style={{ fontWeight: 400 }}>(không bắt buộc)</span>
              {info.hasWebhookSecret && <Badge tone="success" dot>Đang nhận</Badge>}
            </span>
          }
          desc="Không khai thì trạng thái “Đã gửi” chỉ nghĩa là Zalo đã nhận yêu cầu. Khai thì màn Tin nhắn hiện thêm lúc hội viên thực sự nhận được tin."
        >
          <div className="stack" style={{ gap: 16 }}>
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>
                Webhook URL — khai ở mục “Webhook” của ứng dụng, bật sự kiện “Người dùng nhận thông báo ZNS”
              </div>
              <CopyText text={info.webhookUrl} />
            </div>
            <WebhookForm info={info} />
          </div>
        </Card>
      </div>
    </>
  );
}
