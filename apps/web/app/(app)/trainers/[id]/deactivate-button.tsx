'use client';

import { useRouter } from 'next/navigation';
import { LoaderCircle, UserMinus } from 'lucide-react';
import { goiApi } from '../../../../lib/client-api';
import { useAction } from '../../../../lib/use-action';

/** Cho nghỉ việc. API chặn khi còn hợp đồng đang dạy — câu lỗi hiện ngay dưới nút. */
export function DeactivateButton({ id, name }: { id: string; name: string }) {
  const router = useRouter();
  const { busy, loi, chay } = useAction();
  return (
    <div className="stack" style={{ gap: 6, alignItems: 'flex-start' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm text-danger"
        disabled={busy}
        onClick={async () => {
          if (!confirm(`Cho ${name} nghỉ việc? HLV sẽ không nhận lịch mới; lịch sử dạy và hoa hồng giữ nguyên.`)) return;
          const r = await chay(() => goiApi(`trainers/${id}`, { method: 'DELETE' }));
          if (r !== undefined) router.refresh();
        }}
      >
        {busy ? <LoaderCircle size={14} className="spin" /> : <UserMinus size={14} />} Cho nghỉ việc
      </button>
      {loi && <span className="small text-danger" role="alert">{loi}</span>}
    </div>
  );
}
