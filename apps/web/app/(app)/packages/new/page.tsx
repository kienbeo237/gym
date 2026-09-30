import type { Metadata } from 'next';
import type { BookingPolicy } from '@pt/contracts';
import { PageHeader } from '../../../../components/ui';
import { apiFetch, requireSession } from '../../../../lib/session';
import { PackageForm } from '../package-form';

export const metadata: Metadata = { title: 'Thêm gói tập' };

export default async function NewPackagePage() {
  const session = await requireSession();
  const phong = await apiFetch<BookingPolicy>('/settings/booking-policy', session);
  return (
    <>
      <PageHeader back={{ href: '/packages', label: 'Gói tập' }} title="Thêm gói tập" />
      <PackageForm phong={phong} />
    </>
  );
}
