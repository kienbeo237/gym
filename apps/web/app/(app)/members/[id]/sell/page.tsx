import type { Metadata } from 'next';
import type { MemberDetail, PackageSummary, Paged, TrainerSummary } from '@pt/contracts';
import { PageHeader } from '../../../../../components/ui';
import { apiFetch, requireSession } from '../../../../../lib/session';
import { SellForm } from './sell-form';

export const metadata: Metadata = { title: 'Bán gói' };

export default async function SellPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const [m, goi, pt] = await Promise.all([
    apiFetch<MemberDetail>(`/members/${encodeURIComponent(id)}`, session),
    apiFetch<Paged<PackageSummary>>('/packages?size=100', session),
    apiFetch<Paged<TrainerSummary>>('/trainers?size=100&status=ACTIVE', session),
  ]);
  // Gia hạn thường giữ HLV cũ: gợi ý người đang dạy hợp đồng gần nhất.
  const ptCu = m.packages.find((p) => p.trainerId)?.trainerId ?? undefined;

  return (
    <>
      <PageHeader
        back={{ href: `/members/${m.id}`, label: m.fullName }}
        title="Bán gói"
        sub={`${m.fullName} · ${m.code}. Hợp đồng, hoá đơn và kế hoạch trả góp được tạo cùng lúc.`}
      />
      <SellForm
        memberId={m.id}
        packages={goi.items.filter((p) => p.isActive)}
        trainers={pt.items}
        defaultTrainerId={ptCu && pt.items.some((t) => t.id === ptCu) ? ptCu : undefined}
      />
    </>
  );
}
