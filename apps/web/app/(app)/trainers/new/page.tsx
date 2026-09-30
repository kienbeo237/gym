import type { Metadata } from 'next';
import { PageHeader } from '../../../../components/ui';
import { requireSession } from '../../../../lib/session';
import { TrainerForm } from '../trainer-form';

export const metadata: Metadata = { title: 'Thêm huấn luyện viên' };

export default async function NewTrainerPage() {
  await requireSession();
  return (
    <>
      <PageHeader
        back={{ href: '/trainers', label: 'Huấn luyện viên' }}
        title="Thêm huấn luyện viên"
        sub="Mỗi HLV tính vào hạn mức gói dịch vụ của phòng. Người đã có tài khoản thì gắn vào đúng tài khoản đó."
      />
      <TrainerForm />
    </>
  );
}
