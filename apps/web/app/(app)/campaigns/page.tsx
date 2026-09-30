import type { Metadata } from 'next';
import Link from 'next/link';
import { Clock, TriangleAlert } from 'lucide-react';
import type { CampaignRow, ZaloOaInfo, ZnsTemplateRow } from '@pt/contracts';
import { Alert, PageHeader } from '../../../components/ui';
import { apiFetch, requireSession } from '../../../lib/session';
import { CampaignBoard, RunNowButton } from './campaign-board';

export const metadata: Metadata = { title: 'Chiến dịch chăm sóc' };

/**
 * Chiến dịch = một điều kiện + một mẫu tin + một khoảng chờ.
 *
 * Worker tự chạy mỗi 30 phút trong giờ hành chính (9h–20h); nút "Chạy ngay" chỉ
 * để chủ phòng thấy kết quả tức thì sau khi chỉnh. Chạy bao nhiêu lần cũng
 * không gửi trùng — mỗi tin có khoá idempotency riêng.
 */
export default async function CampaignsPage() {
  const session = await requireSession();
  const [campaigns, templates, oa] = await Promise.all([
    apiFetch<CampaignRow[]>('/campaigns', session),
    apiFetch<ZnsTemplateRow[]>('/zalo/templates', session),
    apiFetch<ZaloOaInfo>('/zalo/oa', session),
  ]);

  const mau = templates.map(({ code, name, status }) => ({ code, name, status }));
  const dangBat = campaigns.filter((c) => c.isActive).length;

  return (
    <>
      <PageHeader
        title="Chiến dịch chăm sóc"
        sub={`${dangBat}/${campaigns.length} chiến dịch đang bật · tự chạy mỗi 30 phút, 9h–20h`}
        actions={<RunNowButton />}
      />

      {oa.status !== 'CONNECTED' && (
        <div className="mb-16">
          <Alert tone="warning" icon={TriangleAlert}>
            <span>
              Zalo OA chưa kết nối nên chiến dịch chưa gửi được tin nào.{' '}
              <Link href="/settings/zalo" className="link">
                Kết nối Zalo OA
              </Link>
            </span>
          </Alert>
        </div>
      )}

      <CampaignBoard campaigns={campaigns} mau={mau} />

      <p className="small muted row-start mt-24" style={{ gap: 6 }}>
        <Clock size={14} /> Tin chiến dịch chỉ gửi từ 8h đến 21h — xếp ngoài giờ đó sẽ tự dời sang 8h sáng hôm sau.
      </p>
    </>
  );
}
