import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type KetQuaSms =
  | { ok: true; msgId: string | null }
  | { ok: false; kind: 'transient' | 'permanent'; error: string };

/**
 * Gửi SMS — kênh DỰ PHÒNG cho mã OTP khi không gửi được qua Zalo (hội viên
 * không thuộc phòng nào có OA, số không dùng Zalo, mẫu OTP chưa duyệt...).
 *
 * Chọn bằng SMS_DRIVER:
 *   log  máy lập trình: tin ghi ra log của worker. Bị CHẶN ở production
 *        (config-guard) — log có mã OTP thô.
 *   off  mặc định ở production: không gửi, tin kết thúc SKIPPED với lý do rõ
 *        ràng trên màn Tin nhắn.
 *
 * Chưa có driver nhà mạng thật: cần hợp đồng brandname (Viettel / VNPT / eSMS…)
 * mà dự án chưa có. Thêm driver = thêm một nhánh trong `send`, không phải sửa
 * worker — worker chỉ biết `enabled` và `send`.
 */
@Injectable()
export class SmsApi {
  private readonly log = new Logger(SmsApi.name);

  constructor(private readonly cfg: ConfigService) {}

  get driver(): 'log' | 'off' {
    const v = this.cfg.get<string>('SMS_DRIVER');
    if (v === 'log' || v === 'off') return v;
    return (this.cfg.get('NODE_ENV') ?? 'development') === 'production' ? 'off' : 'log';
  }

  get enabled(): boolean {
    return this.driver !== 'off';
  }

  async send(args: { phone: string; text: string; trackingId: string }): Promise<KetQuaSms> {
    if (this.driver === 'off') return { ok: false, kind: 'permanent', error: 'SMS_NOT_CONFIGURED: chưa cấu hình nhà cung cấp SMS' };
    this.log.log(`[SMS:log] #${args.trackingId} -> ${args.phone}: ${args.text}`);
    return { ok: true, msgId: `log-${args.trackingId}` };
  }
}

/**
 * Bỏ dấu tiếng Việt. SMS có dấu là UCS-2: 70 ký tự một tin thay vì 160, giá gấp
 * đôi — và nhiều brandname chỉ được duyệt mẫu không dấu.
 */
export function khongDau(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^\x20-\x7E]/g, '');
}
