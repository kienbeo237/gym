import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

/**
 * Lời gọi HTTP tới Zalo — và CHỈ lời gọi HTTP. Không đọc CSDL, không giữ token.
 *
 * Tách riêng vì một lý do: mọi lời gọi ở đây phải nằm NGOÀI transaction. Mạng
 * tới Zalo chậm vài giây là chuyện thường; giữ transaction trong lúc đó là giữ
 * khoá trên outbox / member_package và kéo sập luồng điểm danh.
 *
 * Hai driver, chọn bằng ZALO_DRIVER:
 *   http  gọi Zalo thật (mặc định khi NODE_ENV=production)
 *   log   máy lập trình: tin chỉ ghi ra log, luồng OAuth quay thẳng về callback
 *         với mã giả — chạy trọn đường ống mà không cần OA thật.
 *
 * URL để cấu hình được (ZALO_OAUTH_BASE, ZALO_ZNS_URL): Zalo đã đổi tên sản
 * phẩm (ZNS -> ZBS Template Message, 01/01/2026) và có thể đổi đường dẫn. Đổi
 * URL là sửa .env, không phải phát hành lại.
 */

export type TokenPair = { accessToken: string; refreshToken: string; expiresInSeconds: number };

export type KetQuaToken =
  | { ok: true; tokens: TokenPair }
  /** `invalid` = refresh token / code đã chết: phải kết nối lại, thử lại vô ích. */
  | { ok: false; kind: 'invalid' | 'transient'; error: string };

export type KetQuaGui =
  | { ok: true; msgId: string }
  /**
   * token     access token bị từ chối -> làm mới rồi thử lại
   * transient mạng / 5xx -> thử lại sau
   * permanent Zalo từ chối nội dung (sai mẫu, số không dùng Zalo...) -> dừng
   */
  | { ok: false; kind: 'token' | 'transient' | 'permanent'; error: string };

// Mã lỗi "access token không hợp lệ / hết hạn" theo tài liệu lỗi OpenAPI của
// Zalo lúc viết. Nếu Zalo đổi mã, lỗi rơi về nhánh `permanent` — tin FAILED và
// hiện trên màn Tin nhắn, không bị nuốt im lặng.
const LOI_TOKEN = new Set([-124, -216, -220]);

const HET_GIO_MS = 10_000;

@Injectable()
export class ZaloApi {
  private readonly log = new Logger(ZaloApi.name);

  constructor(private readonly cfg: ConfigService) {}

  get driver(): 'http' | 'log' {
    const v = this.cfg.get<string>('ZALO_DRIVER');
    if (v === 'http' || v === 'log') return v;
    return (this.cfg.get('NODE_ENV') ?? 'development') === 'production' ? 'http' : 'log';
  }

  private get oauthBase(): string {
    return this.cfg.get('ZALO_OAUTH_BASE') || 'https://oauth.zaloapp.com/v4/oa';
  }

  private get znsUrl(): string {
    return this.cfg.get('ZALO_ZNS_URL') || 'https://business.openapi.zalo.me/message/template';
  }

  /** Trang Zalo nơi chủ phòng bấm "Đồng ý" cấp quyền cho ứng dụng. */
  authorizeUrl(args: { appId: string; redirectUri: string; codeChallenge: string; state: string }): string {
    if (this.driver === 'log') {
      // Không có Zalo thật: quay về callback ngay với mã giả.
      const u = new URL(args.redirectUri);
      u.searchParams.set('code', `dev-${randomUUID()}`);
      u.searchParams.set('state', args.state);
      u.searchParams.set('oa_id', 'dev-oa');
      return u.toString();
    }
    const u = new URL(`${this.oauthBase}/permission`);
    u.searchParams.set('app_id', args.appId);
    u.searchParams.set('redirect_uri', args.redirectUri);
    u.searchParams.set('code_challenge', args.codeChallenge);
    u.searchParams.set('state', args.state);
    return u.toString();
  }

  exchangeCode(args: { appId: string; secretKey: string; code: string; codeVerifier: string }): Promise<KetQuaToken> {
    return this.token(args.appId, args.secretKey, {
      grant_type: 'authorization_code',
      code: args.code,
      code_verifier: args.codeVerifier,
    });
  }

  /**
   * Refresh token của Zalo chỉ dùng được MỘT LẦN: gọi thành công là token cũ
   * chết. Bên gọi PHẢI giữ khoá phân tán và PHẢI lưu cặp token mới ngay.
   */
  refresh(args: { appId: string; secretKey: string; refreshToken: string }): Promise<KetQuaToken> {
    return this.token(args.appId, args.secretKey, {
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
    });
  }

  private async token(appId: string, secretKey: string, body: Record<string, string>): Promise<KetQuaToken> {
    if (this.driver === 'log') {
      this.log.log(`[ZALO:log] ${body.grant_type} cho app ${appId}`);
      return {
        ok: true,
        tokens: { accessToken: `dev-at-${randomUUID()}`, refreshToken: `dev-rt-${randomUUID()}`, expiresInSeconds: 90_000 },
      };
    }

    let res: Response;
    try {
      res = await fetch(`${this.oauthBase}/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', secret_key: secretKey },
        body: new URLSearchParams({ app_id: appId, ...body }),
        signal: AbortSignal.timeout(HET_GIO_MS),
      });
    } catch (e) {
      return { ok: false, kind: 'transient', error: `Không gọi được Zalo: ${String(e)}` };
    }
    if (res.status >= 500) return { ok: false, kind: 'transient', error: `Zalo trả HTTP ${res.status}` };

    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof j.access_token === 'string' && typeof j.refresh_token === 'string') {
      // expires_in là CHUỖI trong phản hồi của Zalo ("90000").
      const giay = Number(j.expires_in);
      return {
        ok: true,
        tokens: {
          accessToken: j.access_token,
          refreshToken: j.refresh_token,
          expiresInSeconds: Number.isFinite(giay) && giay > 0 ? giay : 3600,
        },
      };
    }
    const moTa = String(j.error_description ?? j.error_name ?? j.message ?? `HTTP ${res.status}`);
    return { ok: false, kind: 'invalid', error: `Zalo từ chối cấp token: ${moTa} (${String(j.error ?? '?')})` };
  }

  /** Gửi tin theo mẫu tới SỐ ĐIỆN THOẠI (ZNS / ZBS Template Message). */
  async sendTemplate(args: {
    accessToken: string;
    phone: string;
    templateId: string;
    data: Record<string, string>;
    trackingId: string;
  }): Promise<KetQuaGui> {
    // Zalo nhận 84xxxxxxxxx, không có dấu '+'.
    const phone = args.phone.replace(/^\+/, '');

    if (this.driver === 'log') {
      // Ở dev, đọc OTP từ log là tiện. Ở production (ai đó đặt ZALO_DRIVER=log
      // để chạy thử) thì log đi vào hệ thống gom log — mã đăng nhập không được lọt.
      const data =
        this.cfg.get('NODE_ENV') === 'production' && args.data.otp ? { ...args.data, otp: '******' } : args.data;
      this.log.log(`[ZALO:log] mẫu ${args.templateId} -> ${phone.slice(0, 4)}***${phone.slice(-3)} ${JSON.stringify(data)}`);
      return { ok: true, msgId: `dev-${randomUUID()}` };
    }

    let res: Response;
    try {
      res = await fetch(this.znsUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', access_token: args.accessToken },
        body: JSON.stringify({
          phone,
          template_id: args.templateId,
          template_data: args.data,
          tracking_id: args.trackingId,
          // Chế độ phát triển của Zalo: chỉ gửi tới quản trị viên OA, không tốn
          // hạn mức — dùng khi chạy thử trên OA thật.
          ...(this.cfg.get('ZALO_ZNS_DEV_MODE') === '1' ? { mode: 'development' } : {}),
        }),
        signal: AbortSignal.timeout(HET_GIO_MS),
      });
    } catch (e) {
      return { ok: false, kind: 'transient', error: `Không gọi được Zalo: ${String(e)}` };
    }
    if (res.status >= 500 || res.status === 429) {
      return { ok: false, kind: 'transient', error: `Zalo trả HTTP ${res.status}` };
    }

    const j = (await res.json().catch(() => ({}))) as { error?: number; message?: string; data?: { msg_id?: string } };
    if (j.error === 0 && j.data?.msg_id) return { ok: true, msgId: String(j.data.msg_id) };

    const loi = `${j.message ?? `HTTP ${res.status}`} (${String(j.error ?? '?')})`;
    if (typeof j.error === 'number' && LOI_TOKEN.has(j.error)) return { ok: false, kind: 'token', error: loi };
    return { ok: false, kind: 'permanent', error: loi };
  }
}
