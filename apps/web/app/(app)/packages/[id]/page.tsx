import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { BookingPolicy, PackageSummary, Paged } from '@pt/contracts';
import { PageHeader } from '../../../../components/ui';
import { apiFetch, requireSession } from '../../../../lib/session';
import { PackageForm } from '../package-form';

export const metadata: Metadata = { title: 'Sửa gói tập' };

export default async function EditPackagePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  // Không có GET /packages/:id — danh mục nhỏ (≤ 100 gói), lấy cả danh sách rồi tìm.
  const [ds, phong] = await Promise.all([
    apiFetch<Paged<PackageSummary>>('/packages?size=100&includeInactive=true', session),
    apiFetch<BookingPolicy>('/settings/booking-policy', session),
  ]);
  const pkg = ds.items.find((p) => p.id === id);
  if (!pkg) notFound();

  return (
    <>
      <PageHeader
        back={{ href: '/packages?all=1', label: 'Gói tập' }}
        title={pkg.name}
        sub={`Mã ${pkg.code} · ${pkg.isActive ? 'đang bán' : 'ngừng bán'} · đã bán ${pkg.soldCount} hợp đồng`}
      />
      <PackageForm key={`${pkg.id}-${pkg.isActive}`} pkg={pkg} phong={phong} />
    </>
  );
}
