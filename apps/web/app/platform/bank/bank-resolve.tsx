'use client';

import { CircleCheck } from 'lucide-react';
import { NoteActions } from '../../../components/note-action';

/** Đánh dấu một giao dịch chưa khớp là đã xử lý ngoài đời, kèm ghi chú bắt buộc. */
export function BankResolve({ id }: { id: string }) {
  return (
    <NoteActions
      actions={[
        {
          key: 'resolve',
          label: 'Đã xử lý',
          icon: CircleCheck,
          primary: true,
          path: `platform/bank-txns/${id}/resolve`,
          desc: 'Chỉ ghi nhận là đã có người xem và xử lý — không đổi hoá đơn nào. Muốn tất toán hoá đơn thì xác nhận tay ở Đối soát thu tiền trước.',
          noteLabel: 'Đã làm gì',
          noteRequired: true,
          placeholder: 'VD: Đã hoàn 950.000đ cho khách ngày 30/9',
          submitLabel: 'Đánh dấu đã xử lý',
          doneText: 'Đã đánh dấu xử lý',
        },
      ]}
    />
  );
}
