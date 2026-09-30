import type { Metadata } from 'next';
import { Package } from 'lucide-react';
import type { MySummary } from '@pt/contracts';
import { EmptyState } from '../../../components/ui';
import { apiFetch, requireSession } from '../../../lib/session';
import { MeBook } from './me-book';

export const metadata: Metadata = { title: 'Đặt lịch tập' };

export default async function MeBookPage({ searchParams }: { searchParams: Promise<{ packageId?: string }> }) {
  const session = await requireSession();
  const { packageId } = await searchParams;
  const s = await apiFetch<MySummary>('/me/summary', session);
  // Chỉ hợp đồng đang dùng, còn buổi và có HLV mới đặt lịch được — thẻ tập tự
  // do (không HLV) thì cứ đến phòng, không cần hẹn.
  const goi = s.packages.filter((p) => p.status === 'ACTIVE' && p.sessionsRemaining > 0 && p.trainerName);

  return (
    <>
      <h1 className="m-title">Đặt lịch tập</h1>
      <p className="m-sub">Chọn giờ trống của huấn luyện viên — đặt xong là giữ chỗ ngay.</p>

      {goi.length === 0 ? (
        <div className="card mt-16">
          <EmptyState
            icon={Package}
            title="Chưa có gói nào đặt lịch được"
            text="Cần một gói tập cùng HLV đang hoạt động và còn buổi. Ghé quầy lễ tân để đăng ký hoặc gia hạn."
          />
        </div>
      ) : (
        <MeBook goi={goi} chon={goi.some((p) => p.id === packageId) ? packageId! : goi[0]!.id} />
      )}
    </>
  );
}
