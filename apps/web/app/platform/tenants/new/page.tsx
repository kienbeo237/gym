import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import type { PlanInfo } from '@pt/contracts';
import { PageHeader } from '../../../../components/ui';
import { apiFetch, duCap, requireSession } from '../../../../lib/session';
import { CreateTenantForm } from './create-tenant-form';

export const metadata: Metadata = { title: 'Tạo phòng tập' };

export default async function NewTenantPage() {
  const session = await requireSession();
  if (!duCap(session, 'OPS')) redirect('/platform/tenants');
  const plans = await apiFetch<PlanInfo[]>('/platform/plans', session);

  return (
    <>
      <PageHeader
        title="Tạo phòng tập"
        sub="Tạo phòng, gói và tài khoản chủ phòng trong một bước."
        back={{ href: '/platform/tenants', label: 'Phòng tập' }}
      />
      <CreateTenantForm plans={plans} />
    </>
  );
}
