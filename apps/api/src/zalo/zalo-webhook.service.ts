import { BadRequestException, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { TenantDb } from '../common/tenant-db.service';
import { moNiemPhong } from '../common/secret-box';

/**
 * Sự kiện webhook của Zalo. Chỉ khai trường dùng tới; Zalo thêm trường mới
 * không làm hỏng việc đọc.
 *
 * `user_received_message` = người nhận đã nhận tin ZNS. `tracking_id` là
 * mã ta gửi kèm lúc gửi (= id dòng outbox), `msg_id` là mã Zalo cấp.
 */
const ZaloEvent = z
  .object({
    event_name: z.string(),
    app_id: z.union([z.string(), z.number()]).optional(),
    timestamp: z.union([z.string(), z.number()]).optional(),
    message: z
      .object({
        msg_id: z.union([z.string(), z.number()]).optional(),
        tracking_id: z.union([z.string(), z.number()]).optional(),
        delivery_time: z.union([z.string(), z.number()]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type KetQuaBaoPhat = 'DELIVERED' | 'ALREADY_DELIVERED' | 'UNMATCHED' | 'IGNORED';

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Nhận báo phát ZNS của MỘT phòng: POST /api/webhooks/zalo/:tenantId.
 *
 * Phòng nằm trong ĐƯỜNG DẪN (mỗi phòng khai URL của mình ở ứng dụng Zalo của
 * họ), không tra theo app_id trong thân: tra ngược app_id -> phòng cần đọc
 * tenant_zalo_oa của MỌI phòng, tức một kết nối vượt RLS cho một endpoint công
 * khai. Ở đây mọi thứ đọc/ghi đều qua runAs(tenantId), RLS áp như thường.
 *
 * Chữ ký: header `X-ZEvent-Signature: mac=<hex>`,
 *   mac = sha256(appId + <thân thô> + timestamp + OA Secret Key)
 * theo tài liệu webhook OA của Zalo lúc viết. CHƯA kiểm với OA thật — xem README.
 *
 * Luôn trả 200 cho sự kiện hợp lệ kể cả khi không khớp tin nào: trả lỗi thì
 * Zalo gửi lại mãi một sự kiện mà ta không bao giờ khớp được.
 */
@Injectable()
export class ZaloWebhookService {
  private readonly log = new Logger(ZaloWebhookService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly cfg: ConfigService,
  ) {}

  async nhan(tenantId: string, raw: Buffer, chuKy: string | undefined): Promise<{ outcome: KetQuaBaoPhat }> {
    const oa = await this.tdb.runAs(tenantId, (tx) =>
      tx.selectFrom('tenant_zalo_oa').select(['app_id', 'webhook_secret_enc']).executeTakeFirst(),
    );
    // Phòng không tồn tại, chưa cấu hình Zalo, hay chưa khai khoá webhook: như nhau — 404.
    if (!oa?.webhook_secret_enc) throw new NotFoundException();

    const khoa = moNiemPhong(this.cfg.getOrThrow('TENANT_SECRET_KEY'), tenantId, 'zalo.webhook', oa.webhook_secret_enc);
    const than = raw.toString('utf8');

    let j: unknown;
    try {
      j = JSON.parse(than);
    } catch {
      throw new BadRequestException('INVALID_JSON');
    }
    const ev = ZaloEvent.safeParse(j);
    if (!ev.success) throw new BadRequestException('INVALID_EVENT');

    const mac = createHash('sha256')
      .update(oa.app_id + than + String(ev.data.timestamp ?? '') + khoa)
      .digest('hex');
    const nhanDuoc = (chuKy ?? '').trim().replace(/^mac=/i, '').toLowerCase();
    // So băm cùng độ dài: không lộ gì qua thời gian phản hồi.
    if (!timingSafeEqual(sha(nhanDuoc), sha(mac))) throw new UnauthorizedException('INVALID_SIGNATURE');
    if (ev.data.app_id !== undefined && String(ev.data.app_id) !== oa.app_id) {
      throw new UnauthorizedException('APP_MISMATCH');
    }

    if (ev.data.event_name !== 'user_received_message') return { outcome: 'IGNORED' };

    const m = ev.data.message ?? {};
    const trackingId = /^\d{1,18}$/.test(String(m.tracking_id ?? '')) ? String(m.tracking_id) : null;
    const msgId = m.msg_id !== undefined && String(m.msg_id) !== '' ? String(m.msg_id) : null;
    const ms = Number(m.delivery_time);
    // Giờ Zalo báo, không phải giờ ta nhận: webhook có thể tới trễ hoặc được gửi lại.
    const luc = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date();
    if (!trackingId && !msgId) return { outcome: 'UNMATCHED' };

    const outcome = await this.tdb.runAs(tenantId, async (tx): Promise<KetQuaBaoPhat> => {
      const tin = await tx
        .selectFrom('notification_outbox')
        .select(['id', 'delivered_at'])
        .where('channel', '=', 'ZALO_ZNS')
        .where((eb) =>
          eb.or([
            ...(trackingId ? [eb('id', '=', trackingId)] : []),
            ...(msgId ? [eb('provider_msg_id', '=', msgId)] : []),
          ]),
        )
        .orderBy('id')
        .limit(1)
        .forUpdate()
        .executeTakeFirst();
      if (!tin) return 'UNMATCHED';
      if (tin.delivered_at) return 'ALREADY_DELIVERED';
      // KHÔNG đổi status: báo phát có thể tới trước khi worker ghi SENT (Zalo
      // nhanh hơn pha 3), và pha 3 không đụng tới delivered_at.
      await tx.updateTable('notification_outbox').set({ delivered_at: luc }).where('id', '=', tin.id).execute();
      return 'DELIVERED';
    });

    if (outcome === 'UNMATCHED') {
      this.log.warn(`Báo phát Zalo phòng ${tenantId} không khớp tin nào (tracking=${trackingId}, msg=${msgId})`);
    }
    return { outcome };
  }
}
