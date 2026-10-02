import { ForbiddenException } from '@nestjs/common';
import { currentContext, type RequestContext } from './tenant-context';

/**
 * RLS cách ly giữa các PHÒNG TẬP. Nó KHÔNG cách ly giữa các HỘI VIÊN trong
 * cùng một phòng — mọi dòng đều mang cùng `tenant_id`.
 *
 * Đó là khoảng trống mà phase 5 (app cho hội viên) biến thành lỗ hổng thật. Đo
 * 29/09/2026 trước khi vá:
 *   - `GET /bookings` do một hội viên gọi trả về 13 buổi tập, gồm HỌ TÊN, MÃ
 *     HỢP ĐỒNG và SỐ BUỔI CÒN LẠI của hai người khác
 *   - `POST /files/upload-url` nhận `ownerId` thẳng từ client, nên hội viên gắn
 *     được ảnh tiến độ cho người khác
 *
 * Quy tắc: **người chỉ có vai trò MEMBER thì mọi truy vấn bị ép về chính họ.**
 * Nhân viên (OWNER/ADMIN/RECEPTION/PT) thì không — họ cần nhìn cả phòng tập.
 *
 * Đặt ở đây, một chỗ, thay vì rải `if (roles.includes('MEMBER'))` khắp service:
 * rải ra là chắc chắn có chỗ quên, và chỗ quên không báo lỗi gì.
 */

const VAI_TRO_NHAN_VIEN = ['OWNER', 'ADMIN', 'RECEPTION', 'PT'] as const;

/** Người này có phải nhân viên phòng tập không (nhìn được dữ liệu cả phòng). */
export function laNhanVien(ctx: RequestContext = must()): boolean {
  return ctx.roles.some((r) => (VAI_TRO_NHAN_VIEN as readonly string[]).includes(r));
}

/**
 * Có vai trò hội viên trong danh sách vai trò (không cần ngữ cảnh request —
 * dùng được lúc cấp token, khi chưa có ngữ cảnh).
 */
export function coVaiHoiVien(roles: readonly string[]): boolean {
  return roles.includes('MEMBER');
}

/** Chỉ là hội viên: không có vai trò nhân viên nào. */
export function chiLaHoiVien(ctx: RequestContext = must()): boolean {
  return !laNhanVien(ctx) && coVaiHoiVien(ctx.roles);
}

/**
 * Ép `memberId` về chính người gọi khi họ chỉ là hội viên.
 *
 * Trả về `undefined` nghĩa là "không lọc theo hội viên" — chỉ xảy ra với nhân
 * viên. Hội viên không có hồ sơ member tại phòng này thì bị từ chối thẳng, thay
 * vì lọt xuống nhánh không-lọc.
 */
export function epPhamViHoiVien(yeuCau?: string): string | undefined {
  const ctx = must();
  if (!chiLaHoiVien(ctx)) return yeuCau;

  if (!ctx.memberId) {
    throw new ForbiddenException({
      code: 'NO_MEMBER_PROFILE',
      message: 'Tài khoản chưa gắn hồ sơ hội viên tại phòng tập này',
    });
  }
  // Cố ý KHÔNG ném lỗi khi client gửi memberId của người khác: trả về dữ liệu
  // của chính họ là hành vi đúng và không tiết lộ rằng id kia có tồn tại.
  return ctx.memberId;
}

/** Chặn thao tác trên hồ sơ của người khác. Dùng cho đường GHI. */
export function assertChinhMinh(memberId: string): void {
  const ctx = must();
  if (!chiLaHoiVien(ctx)) return;
  if (ctx.memberId !== memberId) {
    throw new ForbiddenException({
      code: 'NOT_YOUR_RECORD',
      message: 'Không thao tác được trên hồ sơ của hội viên khác',
    });
  }
}

function must(): RequestContext {
  const ctx = currentContext();
  if (!ctx) throw new Error('TENANT_CONTEXT_MISSING');
  return ctx;
}
