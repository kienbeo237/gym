'use client';

import { useEffect, useId, useRef, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { DayPicker, type Matcher } from 'react-day-picker';
import { vi } from 'react-day-picker/locale';
import { CalendarDays, Clock } from 'lucide-react';

/*
 * Ô chọn NGÀY và GIỜ dùng chung — thay <input type="date|time">: ô gốc mỗi
 * trình duyệt một kiểu (Safari iOS hiện "2 thg 10, 2026", Chrome Windows hiện
 * mm/dd/yyyy theo máy) và không đổi được giao diện cho khớp phần còn lại.
 *
 * Giá trị vào/ra vẫn là CHUỖI như ô gốc ('YYYY-MM-DD', 'HH:mm') để form không
 * phải đổi kiểu dữ liệu. Ngày là ngày lịch (không giờ, không múi giờ): đọc/ghi
 * bằng getFullYear/getMonth/getDate của giờ máy, không qua toISOString — đi
 * qua UTC là lệch một ngày với người dùng ở UTC+7 lúc 0h–7h sáng.
 */

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function tuIso(s: string | undefined): Date | undefined {
  const m = s ? ISO.exec(s) : null;
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : undefined;
}

const hai = (n: number) => String(n).padStart(2, '0');
const raIso = (d: Date) => `${d.getFullYear()}-${hai(d.getMonth() + 1)}-${hai(d.getDate())}`;
const hienThi = (iso: string) => {
  const d = tuIso(iso);
  return d ? `${hai(d.getDate())}/${hai(d.getMonth() + 1)}/${d.getFullYear()}` : '';
};

/** Gõ tay: 2/10/2026, 02-10-2026, 02.10.26, 0210 2026 … -> ISO, hoặc null nếu không hợp lệ. */
function docGoTay(s: string): string | null {
  const so = s.trim().split(/[^\d]+/).filter(Boolean);
  if (so.length !== 3) return null;
  const [d, m] = so.map(Number) as [number, number];
  let y = Number(so[2]);
  if (so[2]!.length === 2) y += 2000;
  const ngay = new Date(y, m - 1, d);
  if (ngay.getFullYear() !== y || ngay.getMonth() !== m - 1 || ngay.getDate() !== d) return null;
  return raIso(ngay);
}

type DatePickerProps = {
  value: string;
  onChange: (iso: string) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  id?: string;
  'aria-label'?: string;
  /** Ngày sinh: chọn năm/tháng bằng ô thả xuống thay vì bấm lùi từng tháng. */
  chonNam?: boolean;
  className?: string;
};

export function DatePicker({
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  placeholder = 'dd/mm/yyyy',
  id,
  chonNam,
  className,
  ...rest
}: DatePickerProps) {
  const tuSinh = useId();
  const [mo, setMo] = useState(false);
  const [chu, setChu] = useState(hienThi(value));
  const [sai, setSai] = useState(false);
  const o = useRef<HTMLInputElement>(null);

  // Giá trị đổi từ ngoài (chọn trên lịch, form đặt lại) -> cập nhật chữ.
  useEffect(() => {
    setChu(hienThi(value));
    setSai(false);
  }, [value]);

  const chon = tuIso(value);
  const tu = tuIso(min);
  const den = tuIso(max);
  const chan: Matcher[] = [];
  if (tu) chan.push({ before: tu });
  if (den) chan.push({ after: den });

  function chot() {
    if (!chu.trim()) {
      setSai(false);
      if (value) onChange('');
      return;
    }
    const iso = docGoTay(chu);
    if (!iso || (min && iso < min) || (max && iso > max)) {
      setSai(true);
      return;
    }
    setSai(false);
    if (iso !== value) onChange(iso);
    else setChu(hienThi(iso));
  }

  return (
    <Popover.Root open={mo} onOpenChange={setMo}>
      <Popover.Anchor asChild>
        <div className={`input-wrap date-field${className ? ` ${className}` : ''}`}>
          <input
            ref={o}
            id={id ?? tuSinh}
            className="input tabular"
            inputMode="numeric"
            autoComplete="off"
            placeholder={placeholder}
            value={chu}
            disabled={disabled}
            required={required}
            aria-invalid={sai || undefined}
            aria-label={rest['aria-label']}
            onChange={(e) => setChu(e.target.value)}
            onBlur={chot}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                chot();
              } else if (e.key === 'ArrowDown' && e.altKey) {
                setMo(true);
              }
            }}
          />
          <Popover.Trigger asChild>
            <button type="button" className="input-action" aria-label="Mở lịch" disabled={disabled}>
              <CalendarDays size={16} />
            </button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="popover"
          align="start"
          sideOffset={6}
          collisionPadding={12}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            o.current?.focus();
          }}
        >
          <DayPicker
            mode="single"
            locale={vi}
            weekStartsOn={1}
            selected={chon}
            defaultMonth={chon ?? den ?? undefined}
            disabled={chan}
            startMonth={tu ?? (chonNam ? new Date(1940, 0) : undefined)}
            endMonth={den ?? (chonNam ? new Date() : undefined)}
            captionLayout={chonNam ? 'dropdown' : 'label'}
            autoFocus
            onSelect={(d) => {
              if (d) onChange(raIso(d));
              setMo(false);
            }}
          />
          <div className="popover-foot">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                const homNay = raIso(new Date());
                if ((!min || homNay >= min) && (!max || homNay <= max)) {
                  onChange(homNay);
                  setMo(false);
                }
              }}
            >
              Hôm nay
            </button>
            {!required && value && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  onChange('');
                  setMo(false);
                }}
              >
                Xoá
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
      {sai && (
        <span className="field-hint text-danger" role="alert">
          Ngày không hợp lệ{min || max ? ` (${[min && `từ ${hienThi(min)}`, max && `đến ${hienThi(max)}`].filter(Boolean).join(' ')})` : ''}.
        </span>
      )}
    </Popover.Root>
  );
}

// ---------------------------------------------------------------------------

const phut = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const raGio = (p: number) => `${hai(Math.floor(p / 60))}:${hai(p % 60)}`;

/**
 * Ô chọn GIỜ: danh sách mốc theo bước (mặc định 15 phút), bấm là xong — nhanh
 * hơn xoay bánh xe giờ/phút trên điện thoại.
 */
export function TimePicker({
  value,
  onChange,
  step = 15,
  min = '05:00',
  max = '23:00',
  disabled,
  'aria-label': ariaLabel,
}: {
  value: string;
  onChange: (hhmm: string) => void;
  step?: number;
  min?: string;
  max?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [mo, setMo] = useState(false);
  const ds = useRef<HTMLDivElement>(null);
  const moc: string[] = [];
  for (let p = phut(min); p <= phut(max); p += step) moc.push(raGio(p));

  // Mở ra là thấy ngay giờ đang chọn, không phải cuộn từ 5h sáng.
  useEffect(() => {
    if (!mo) return;
    const t = requestAnimationFrame(() =>
      ds.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'center' }),
    );
    return () => cancelAnimationFrame(t);
  }, [mo]);

  return (
    <Popover.Root open={mo} onOpenChange={setMo}>
      <Popover.Trigger asChild>
        <button type="button" className="input time-field tabular" disabled={disabled} aria-label={ariaLabel}>
          <Clock size={15} className="faint" />
          <span>{value || '--:--'}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover popover-list" align="start" sideOffset={6} collisionPadding={12}>
          <div ref={ds} role="listbox" aria-label={ariaLabel} className="time-list">
            {moc.map((g) => (
              <button
                key={g}
                type="button"
                role="option"
                aria-selected={g === value}
                className="time-opt tabular"
                onClick={() => {
                  onChange(g);
                  setMo(false);
                }}
              >
                {g}
              </button>
            ))}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
