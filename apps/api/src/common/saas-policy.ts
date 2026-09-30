import { ForbiddenException } from '@nestjs/common';

/**
 * Luật thời gian của thuê bao SaaS — MỘT nơi khai.
 *
 * Worker truyền hai số này vào `saas_lifecycle_tick(p_today, p_lead_days,
 * p_grace_days)` (migration 0016), và màn "Gói dịch vụ" dùng chúng để báo trước
 * ngày bị khoá. Khai ở hai nơi là hai nơi báo hai ngày khác nhau.
 */

/** Phát hành hoá đơn kỳ tới trước ngày hết kỳ đã trả bao nhiêu ngày. */
export const SAAS_LEAD_DAYS = 7;

/** Quá hạn bao nhiêu ngày thì tạm khoá (chỉ đọc). */
export const SAAS_GRACE_DAYS = 7;

/** Ngày YYYY-MM-DD cộng n ngày, không đi qua múi giờ nào. */
export function congNgay(ngay: string, n: number): string {
  const [y, m, d] = ngay.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Lỗi `QUOTA_EXCEEDED:<loại>:<đã dùng>:<hạn mức>` của assert_quota (0007) ->
 * 403 PLAN_LIMIT_REACHED kèm lời nhắn nâng gói. Lỗi khác thì ném lại nguyên.
 *
 * 403 chứ không 400: yêu cầu hợp lệ, chỉ là gói hiện tại không cho phép —
 * web dựa vào mã này để hiện nút "Xem gói dịch vụ" thay vì báo "nhập sai".
 *
 * Chỉ chặn TẠO MỚI. Người đã có không bị đụng tới, phòng không bị khoá: hạ gói
 * khi đang đông khách thì vẫn chạy bình thường, chỉ không thêm được nữa.
 */
export function loiHanMucGoi(e: unknown, loai: 'member' | 'trainer'): never {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /QUOTA_EXCEEDED:(\w+):(\d+):(\d+)/.exec(msg);
  if (!m) throw e;
  const ten = loai === 'member' ? 'hội viên' : 'huấn luyện viên';
  throw new ForbiddenException({
    code: 'PLAN_LIMIT_REACHED',
    message: `Gói dịch vụ hiện tại cho tối đa ${m[3]} ${ten} (đang có ${m[2]}). Nâng gói ở Cài đặt → Gói dịch vụ để thêm ${ten} mới.`,
    details: { kind: loai, used: Number(m[2]), limit: Number(m[3]) },
  });
}
