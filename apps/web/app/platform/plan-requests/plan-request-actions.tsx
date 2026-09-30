'use client';

import { CircleCheck, CircleX } from 'lucide-react';
import { NoteActions } from '../../../components/note-action';

/** Duyệt (ghi chú tuỳ chọn) hoặc từ chối (bắt buộc lý do) một yêu cầu đổi gói. */
export function PlanRequestActions({ id, toPlanName }: { id: string; toPlanName: string }) {
  return (
    <NoteActions
      actions={[
        {
          key: 'approve',
          label: 'Duyệt',
          icon: CircleCheck,
          primary: true,
          path: `platform/plan-requests/${id}/approve`,
          desc: `Phòng chuyển sang gói ${toPlanName} ngay. Hạn mức mới có hiệu lực tức thì; giá mới áp từ hoá đơn kỳ sau.`,
          placeholder: 'VD: Đã gọi xác nhận với chủ phòng',
          submitLabel: `Duyệt, chuyển sang ${toPlanName}`,
          doneText: `Đã duyệt — phòng đã sang gói ${toPlanName}`,
        },
        {
          key: 'reject',
          label: 'Từ chối',
          icon: CircleX,
          path: `platform/plan-requests/${id}/reject`,
          desc: 'Gói giữ nguyên. Chủ phòng sẽ thấy lý do ở trang Gói dịch vụ và có thể gửi yêu cầu khác.',
          noteLabel: 'Lý do',
          noteRequired: true,
          placeholder: 'VD: Phòng còn nợ hoá đơn kỳ trước',
          submitLabel: 'Từ chối yêu cầu',
          doneText: 'Đã từ chối yêu cầu',
        },
      ]}
    />
  );
}
