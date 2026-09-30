'use client';

import { useEffect, useState } from 'react';
import { CalendarX, ChevronLeft, ChevronRight, Info, LoaderCircle } from 'lucide-react';
import type { AvailableSlots } from '@pt/contracts';
import { goiApi, thongBaoLoi } from '../lib/client-api';
import { TZ, dichNgay, gioVN, ngayVN } from '../lib/format';
import { Alert, EmptyState } from './ui';

export type Slot = { startsAt: string; endsAt: string };

const THOI_LUONG = [30, 45, 60, 90];

/**
 * Chọn một khung giờ trống của hợp đồng. Khung trống do API tính (lịch nhận
 * dạy của HLV − buổi đã có của HLV và của hội viên − quá khứ − ngoài hạn gói),
 * màn này chỉ hiện ra — không tự suy luận thêm gì.
 */
export function SlotPicker({
  memberPackageId,
  value,
  onChange,
  duration,
  onDurationChange,
  fixedDuration,
}: {
  memberPackageId: string;
  value: Slot | null;
  onChange: (s: Slot | null) => void;
  duration: number;
  onDurationChange?: (m: number) => void;
  /** Đổi giờ thì giữ thời lượng cũ — ẩn ô chọn. */
  fixedDuration?: boolean;
}) {
  const homNay = ngayVN();
  const [tu, setTu] = useState(homNay);
  const [data, setData] = useState<AvailableSlots | null>(null);
  const [ngay, setNgay] = useState<string | null>(null);
  const [dangTai, setDangTai] = useState(false);
  const [loi, setLoi] = useState('');

  useEffect(() => {
    let huy = false;
    setDangTai(true);
    setLoi('');
    goiApi<AvailableSlots>(
      `bookings/slots?memberPackageId=${memberPackageId}&from=${tu}&days=7&durationMinutes=${duration}`,
    )
      .then((d) => {
        if (huy) return;
        setData(d);
        // Giữ ngày đang chọn nếu còn trong tuần; không thì nhảy tới ngày đầu còn khung.
        setNgay((cu) =>
          cu && d.days.some((x) => x.date === cu && x.slots.length > 0)
            ? cu
            : (d.days.find((x) => x.slots.length > 0)?.date ?? d.days[0]?.date ?? null),
        );
      })
      .catch((e) => !huy && setLoi(thongBaoLoi(e)))
      .finally(() => !huy && setDangTai(false));
    return () => {
      huy = true;
    };
  }, [memberPackageId, tu, duration]);

  const ngayChon = data?.days.find((d) => d.date === ngay);
  const tongKhung = data?.days.reduce((s, d) => s + d.slots.length, 0) ?? 0;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        <div className="row-start" style={{ gap: 6 }}>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-icon"
            aria-label="Tuần trước"
            disabled={tu <= homNay || dangTai}
            onClick={() => {
              const lui = dichNgay(tu, -7);
              setTu(lui < homNay ? homNay : lui);
            }}
          >
            <ChevronLeft size={16} />
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm btn-icon"
            aria-label="Tuần sau"
            disabled={dangTai}
            onClick={() => setTu(dichNgay(tu, 7))}
          >
            <ChevronRight size={16} />
          </button>
          {dangTai && <LoaderCircle size={16} className="spin faint" />}
        </div>
        {!fixedDuration && onDurationChange && (
          <div className="segmented" role="tablist" aria-label="Thời lượng buổi">
            {THOI_LUONG.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={duration === m}
                onClick={() => {
                  onChange(null);
                  onDurationChange(m);
                }}
              >
                {m}′
              </button>
            ))}
          </div>
        )}
      </div>

      {loi && (
        <Alert tone="danger" icon={CalendarX}>
          <span>{loi}</span>
        </Alert>
      )}

      {data && (
        <>
          <div className="slot-days" role="group" aria-label="Chọn ngày">
            {data.days.map((d) => {
              const t = new Date(`${d.date}T12:00:00+07:00`);
              return (
                <button
                  key={d.date}
                  type="button"
                  className="slot-day"
                  aria-pressed={d.date === ngay}
                  disabled={d.slots.length === 0}
                  onClick={() => setNgay(d.date)}
                >
                  <span>{d.date === homNay ? 'Hôm nay' : t.toLocaleDateString('vi-VN', { timeZone: TZ, weekday: 'short' })}</span>
                  <strong>{t.toLocaleDateString('vi-VN', { timeZone: TZ, day: '2-digit' })}</strong>
                  <small>{d.slots.length > 0 ? `${d.slots.length} khung` : 'kín'}</small>
                </button>
              );
            })}
          </div>

          {tongKhung === 0 ? (
            <EmptyState
              icon={CalendarX}
              title="Tuần này không còn khung trống"
              text={
                data.bookableSessions <= 0
                  ? 'Hợp đồng đã đặt hết số buổi còn lại.'
                  : 'Thử tuần sau, hoặc đổi thời lượng buổi.'
              }
            />
          ) : ngayChon && ngayChon.slots.length > 0 ? (
            <div className="slot-grid" role="group" aria-label="Chọn giờ">
              {ngayChon.slots.map((s) => (
                <button
                  key={s.startsAt}
                  type="button"
                  className="slot"
                  aria-pressed={value?.startsAt === s.startsAt}
                  onClick={() => onChange(value?.startsAt === s.startsAt ? null : s)}
                >
                  {gioVN(s.startsAt)}
                </button>
              ))}
            </div>
          ) : null}

          <p className="small muted row-start" style={{ gap: 6, margin: 0, alignItems: 'flex-start' }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              HLV {data.trainerName}
              {data.hasAvailability ? '' : ' chưa khai lịch nhận dạy — đang gợi ý theo giờ mở cửa 06:00–21:00'}
              {' · '}còn đặt thêm được <b>{data.bookableSessions}</b> buổi.
            </span>
          </p>
        </>
      )}
    </div>
  );
}
