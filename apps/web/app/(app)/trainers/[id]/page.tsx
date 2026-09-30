import type { Metadata } from 'next';
import { CalendarRange, Mail, Phone } from 'lucide-react';
import type { TrainerDetail } from '@pt/contracts';
import { Avatar, Badge, Card, PageHeader, type Tone } from '../../../../components/ui';
import { ngayISO } from '../../../../lib/format';
import { apiFetch, requireSession } from '../../../../lib/session';
import { TrainerForm } from '../trainer-form';
import { AvailabilityEditor } from './availability-editor';
import { DeactivateButton } from './deactivate-button';

export const metadata: Metadata = { title: 'Huấn luyện viên' };

const TRANG_THAI: Record<string, { text: string; tone: Tone }> = {
  ACTIVE: { text: 'Đang làm', tone: 'success' },
  SUSPENDED: { text: 'Tạm nghỉ', tone: 'warning' },
  LEFT: { text: 'Đã nghỉ', tone: 'neutral' },
};

export default async function TrainerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const t = await apiFetch<TrainerDetail>(`/trainers/${encodeURIComponent(id)}`, session);
  const tt = TRANG_THAI[t.status] ?? { text: t.status, tone: 'neutral' as const };

  return (
    <>
      <PageHeader
        back={{ href: '/trainers', label: 'Huấn luyện viên' }}
        title={
          <span className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
            <Avatar name={t.fullName} />
            {t.fullName}
            <Badge tone={tt.tone} dot>
              {tt.text}
            </Badge>
          </span>
        }
        sub={
          <span className="meta-line">
            <span>{t.code}</span>
            <span>
              <Phone size={13} /> {t.phone}
            </span>
            {t.email && (
              <span>
                <Mail size={13} /> {t.email}
              </span>
            )}
            <span>{t.activePackages} hợp đồng đang dạy</span>
            {t.leftOn && <span>nghỉ từ {ngayISO(t.leftOn)}</span>}
          </span>
        }
        actions={t.status !== 'LEFT' ? <DeactivateButton id={t.id} name={t.fullName} /> : undefined}
      />

      <div className="stack" style={{ gap: 20 }}>
        <TrainerForm trainer={t} />
        <Card
          title={
            <span className="row-start" style={{ gap: 8 }}>
              <CalendarRange size={17} /> Lịch nhận dạy
            </span>
          }
          desc="Hội viên chỉ tự đặt được trong các khung này. Chưa khai khung nào thì gợi ý theo giờ mở cửa 06:00–21:00."
        >
          <AvailabilityEditor trainerId={t.id} initial={t.availability} />
        </Card>
      </div>
    </>
  );
}
