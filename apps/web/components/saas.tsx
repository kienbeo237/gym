import type { UsageMeter } from '@pt/contracts';

/**
 * Thanh "đã dùng / hạn mức" của gói. `limit` null = không giới hạn — vẫn hiện
 * số đã dùng, không vẽ thanh (thanh rỗng mãi trông như lỗi).
 *
 * Từ 80% chuyển vàng, chạm trần chuyển đỏ: chủ phòng cần thấy TRƯỚC khi tin
 * nhắn bắt đầu bị bỏ qua, không phải sau.
 */
export function UsageBar({ label, m, compact }: { label: string; m: UsageMeter; compact?: boolean }) {
  const pct = m.limit ? Math.min(100, Math.round((m.used / m.limit) * 100)) : 0;
  const tone = m.limit === null ? undefined : pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : undefined;
  return (
    <div className="meter">
      <div className="meter-top">
        <span className={compact ? 'small muted' : undefined}>{label}</span>
        <span className={compact ? 'small' : undefined}>
          {m.used.toLocaleString('vi-VN')}
          {m.limit === null ? ' · không giới hạn' : ` / ${m.limit.toLocaleString('vi-VN')}`}
        </span>
      </div>
      {m.limit !== null && (
        <div className="progress" data-tone={tone} aria-label={`${label}: ${pct}%`}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

export const hanMuc = (n: number | null, donVi: string) =>
  n === null ? `Không giới hạn ${donVi}` : `${n.toLocaleString('vi-VN')} ${donVi}`;
