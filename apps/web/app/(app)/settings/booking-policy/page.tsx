import type { Metadata } from 'next';
import { Info } from 'lucide-react';
import type { BookingPolicy } from '@pt/contracts';
import { Alert, PageHeader } from '../../../../components/ui';
import { apiFetch, requireSession } from '../../../../lib/session';
import { PolicyForm } from './policy-form';

export const metadata: Metadata = { title: 'Chính sách đặt lịch' };

/**
 * Chính sách MẶC ĐỊNH của phòng. Từng gói tập ghi đè được huỷ muộn / vắng có
 * trừ buổi hay không — nên câu chữ ở đây nói "mặc định", không nói "luôn luôn".
 */
export default async function BookingPolicyPage() {
  const session = await requireSession();
  const policy = await apiFetch<BookingPolicy>('/settings/booking-policy', session);
  const laChu = session.roles.includes('OWNER');

  return (
    <>
      <PageHeader title="Chính sách đặt lịch" sub="Quy tắc huỷ buổi, vắng mặt và điểm danh áp cho mọi gói tập" />
      {!laChu && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>Chỉ chủ phòng tập đổi được chính sách — các quy tắc này quyết định buổi tập của hội viên có bị trừ hay không.</span>
          </Alert>
        </div>
      )}
      <PolicyForm policy={policy} readOnly={!laChu} />
    </>
  );
}
