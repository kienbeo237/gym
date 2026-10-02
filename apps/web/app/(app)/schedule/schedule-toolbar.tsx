'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker } from 'react-day-picker';
import { vi } from 'react-day-picker/locale';
import { CalendarDays, ChevronDown, UserRound } from 'lucide-react';

type Lich = { view: 'day' | 'week'; date: string; trainer: string };

const hai = (n: number) => String(n).padStart(2, '0');
const raIso = (d: Date) => `${d.getFullYear()}-${hai(d.getMonth() + 1)}-${hai(d.getDate())}`;
const tuIso = (s: string) => {
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

// Bản sao của duongDan trong page.tsx: hàm từ file 'use client' không gọi được
// ở server component.
const duongDanLich = (l: Lich) => {
  const p = new URLSearchParams({ view: l.view, date: l.date });
  if (l.trainer) p.set('trainer', l.trainer);
  return `/schedule?${p.toString()}`;
};

/**
 * Hai ô điều khiển cần JavaScript của màn lịch: lịch tháng nhỏ để nhảy tới một
 * ngày bất kỳ, và lọc theo HLV. Phần còn lại của màn là server component —
 * mọi trạng thái nằm trên URL, nên F5 / gửi link / nút Back đều đúng chỗ.
 */
export function ScheduleToolbar({
  lich,
  nhan,
  trainers,
  cuaToi,
}: {
  lich: Lich;
  /** Chữ trên nút chọn ngày, vd. "Tháng 10, 2026" hoặc "Thứ 6, 02/10". */
  nhan: string;
  trainers: { id: string; fullName: string }[];
  /** id HLV của người đang đăng nhập (nếu là HLV) — thêm lựa chọn "Lịch của tôi". */
  cuaToi: string | null;
}) {
  const router = useRouter();
  const [mo, setMo] = useState(false);
  const di = (p: Partial<Lich>) => router.push(duongDanLich({ ...lich, ...p }));

  return (
    <div className="row-start" style={{ gap: 8, flexWrap: 'wrap' }}>
      <Popover.Root open={mo} onOpenChange={setMo}>
        <Popover.Trigger asChild>
          <button type="button" className="btn btn-secondary" aria-label="Chọn ngày">
            <CalendarDays size={16} />
            <span style={{ textTransform: 'capitalize' }}>{nhan}</span>
            <ChevronDown size={14} className="faint" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content className="popover" align="start" sideOffset={6} collisionPadding={12}>
            <DayPicker
              mode="single"
              locale={vi}
              weekStartsOn={1}
              showOutsideDays
              selected={tuIso(lich.date)}
              defaultMonth={tuIso(lich.date)}
              autoFocus
              onSelect={(d) => {
                setMo(false);
                if (d) di({ date: raIso(d) });
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <label className="input-wrap" style={{ minWidth: 200 }}>
        <UserRound size={15} />
        <select
          className="input"
          aria-label="Lọc theo huấn luyện viên"
          value={lich.trainer || 'all'}
          onChange={(e) => di({ trainer: e.target.value })}
        >
          {cuaToi && <option value={cuaToi}>Lịch của tôi</option>}
          {/* 'all' chứ không phải '' — HLV không có tham số thì mặc định là lịch của mình. */}
          <option value="all">Tất cả HLV</option>
          {trainers
            .filter((t) => t.id !== cuaToi)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.fullName}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
