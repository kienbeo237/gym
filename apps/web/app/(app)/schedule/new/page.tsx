import type { Metadata } from 'next';
import type { MemberDetail } from '@pt/contracts';
import { PageHeader } from '../../../../components/ui';
import { apiFetch, requireSession } from '../../../../lib/session';
import { NewBooking } from './new-booking';

export const metadata: Metadata = { title: 'Đặt lịch' };

/** Mở từ hồ sơ hội viên thì đã biết người (và có thể cả hợp đồng) — bỏ qua bước tìm. */
export default async function NewBookingPage({
  searchParams,
}: {
  searchParams: Promise<{ memberId?: string; packageId?: string }>;
}) {
  const session = await requireSession();
  const { memberId, packageId } = await searchParams;
  const member =
    memberId && /^[0-9a-f-]{36}$/i.test(memberId)
      ? await apiFetch<MemberDetail>(`/members/${memberId}`, session)
      : null;

  return (
    <>
      <PageHeader
        back={member ? { href: `/members/${member.id}`, label: member.fullName } : { href: '/schedule', label: 'Lịch tập' }}
        title="Đặt lịch"
        sub="Chỉ hiện khung giờ HLV nhận dạy mà cả HLV lẫn hội viên đều trống."
      />
      <NewBooking initial={member} initialPackageId={packageId} />
    </>
  );
}
