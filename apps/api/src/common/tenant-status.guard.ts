import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { AccessTokenClaims } from '@pt/contracts';
import { TenantDb } from './tenant-db.service';

const CHI_DOC = new Set(['GET', 'HEAD', 'OPTIONS']);
const SONG_MS = 30_000;

/**
 * Trạng thái PHÒNG TẬP, kiểm ở MỌI request — không chỉ lúc đăng nhập.
 *
 * Trước phase 7 chỉ bước chọn phòng kiểm `tenant.status`. Access token sống 15
 * phút và refresh token 30 ngày, nên một phòng bị khoá vẫn dùng tiếp được tới
 * lúc làm mới token — và nếu làm mới không kiểm thì mãi mãi.
 *
 *   SUSPENDED  chỉ đọc: GET được, ghi bị từ chối. Chủ phòng vẫn phải xem được
 *              hoá đơn dịch vụ để trả tiền; lễ tân vẫn tra được lịch để báo
 *              khách. Không có dữ liệu nào bị giữ làm con tin.
 *   CLOSED     không gì cả.
 *
 * Nhớ đệm 30 giây TRONG TIẾN TRÌNH: một truy vấn mỗi request là thừa, còn trễ
 * 30 giây sau khi nền tảng khoá / mở khoá là chấp nhận được. Không đặt vào
 * Redis — Redis chết thì guard này phải vẫn chạy.
 *
 * Chạy SAU JwtAuthGuard (thứ tự khai báo APP_GUARD trong AppModule).
 */
@Injectable()
export class TenantStatusGuard implements CanActivate {
  private readonly nho = new Map<string, { status: string; het: number }>();

  constructor(private readonly tdb: TenantDb) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const claims = req.user as Partial<AccessTokenClaims> | undefined;
    if (!claims?.tid) return true; // route công khai, hoặc phiên nền tảng

    const status = await this.trangThai(claims.tid);
    if (status === 'CLOSED' || status === null) {
      throw new UnauthorizedException({ code: 'TENANT_CLOSED', message: 'Phòng tập đã ngừng sử dụng dịch vụ.' });
    }
    if (status === 'SUSPENDED' && !CHI_DOC.has(String(req.method).toUpperCase())) {
      throw new ForbiddenException({
        code: 'TENANT_SUSPENDED',
        message:
          'Phòng tập đang tạm khoá nên chỉ xem được, không ghi được dữ liệu. Chủ phòng vui lòng thanh toán hoá đơn dịch vụ (Cài đặt → Gói dịch vụ) để mở lại.',
      });
    }
    return true;
  }

  private async trangThai(tenantId: string): Promise<string | null> {
    const bay = Date.now();
    const c = this.nho.get(tenantId);
    if (c && c.het > bay) return c.status;

    const row = await this.tdb.runAs(tenantId, (tx) => tx.selectFrom('tenant').select('status').executeTakeFirst());
    const status = row?.status ?? null;
    if (status) this.nho.set(tenantId, { status, het: bay + SONG_MS });
    // Chặn phình bộ nhớ vô hạn nếu có rất nhiều phòng: xoá sạch khi quá lớn.
    if (this.nho.size > 5_000) this.nho.clear();
    return status;
  }
}
