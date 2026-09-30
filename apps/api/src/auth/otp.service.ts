import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Kysely } from 'kysely';
import type { DB } from '@pt/contracts';
import { DB_AUTH } from '../db/database.module';
import { RateLimitService } from '../redis/rate-limit.service';
import { globalKey, phoneKeyPart } from '../redis/redis-keys';
import { niemPhong } from '../common/secret-box';
import { SmsApi } from '../sms/sms-api';

const MA_SO_CHU_SO = 6;
const HAN_DUNG_GIAY = 300;      // 5 phút
const CHO_GUI_LAI_GIAY = 60;
const SO_LAN_NHAP_SAI_TOI_DA = 5;

/**
 * Đăng nhập bằng OTP — đường chính cho hội viên.
 *
 * Hội viên phòng gym không nhớ mật khẩu; họ được lễ tân tạo tài khoản rồi
 * không bao giờ đăng nhập lại cho tới khi cần xem số buổi còn lại. Mật khẩu chỉ
 * giữ cho nhân viên.
 *
 * SÁU ĐIỂM BẮT BUỘC, mỗi điểm ứng với một cách phá:
 *
 *  1. KHÔNG lưu mã thô. Lưu sha256; lộ CSDL không kéo theo lộ mã đang hiệu lực.
 *  2. So sánh THỜI GIAN HẰNG (timingSafeEqual). So bằng `===` để lộ thông tin
 *     qua thời gian phản hồi.
 *  3. KHÔNG tiết lộ số điện thoại có tồn tại hay không. Số lạ vẫn trả "đã gửi"
 *     — chỉ là không có mã nào được tạo. Trả lỗi khác nhau là biến endpoint này
 *     thành công cụ dò danh sách khách hàng.
 *  4. Đếm số lần nhập sai TRÊN CHÍNH bản ghi OTP, không chỉ trên Redis. Redis
 *     là bộ nhớ tạm; mất nó là mất bộ đếm, và kẻ tấn công chỉ cần chờ nó khởi
 *     động lại. 10^6 tổ hợp thì 5 lần thử là hàng rào thật sự.
 *  5. Mã dùng MỘT LẦN (`consumed_at`). Không có nó thì mã còn hiệu lực 5 phút
 *     sau khi đã đăng nhập, và nó nằm trong tin nhắn đã gửi đi.
 *  6. randomInt của node:crypto, KHÔNG phải Math.random. Math.random đoán được.
 */
@Injectable()
export class OtpService {
  private readonly log = new Logger(OtpService.name);

  constructor(
    @Inject(DB_AUTH) private readonly db: Kysely<DB>,
    private readonly rate: RateLimitService,
    private readonly cfg: ConfigService,
    private readonly sms: SmsApi,
  ) {}

  private hash(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private get laMoiTruongDev(): boolean {
    return (this.cfg.get('NODE_ENV') ?? 'development') !== 'production';
  }

  /**
   * Gửi mã. Luôn trả về như nhau dù số điện thoại có tồn tại hay không.
   * Ở môi trường dev có trả kèm `devCode` để thử mà không cần kênh gửi thật.
   */
  async request(phone: string): Promise<{ sent: true; devCode?: string }> {
    const kPhone = phoneKeyPart(phone, (s) => this.hash(s));

    // Hai tầng chặn: theo phút (chống bấm liên tục) và theo giờ (chống rải).
    const perMinute = await this.rate.hit(globalKey('otp', 'req', kPhone), 1, CHO_GUI_LAI_GIAY);
    if (!perMinute.allowed) {
      throw new BadRequestException({
        code: 'OTP_TOO_SOON',
        message: `Vui lòng đợi ${perMinute.retryAfterSeconds} giây trước khi gửi lại mã`,
        retryAfterSeconds: perMinute.retryAfterSeconds,
      });
    }
    const perHour = await this.rate.hit(globalKey('otp', 'req1h', kPhone), 5, 3600);
    if (!perHour.allowed) {
      throw new BadRequestException({
        code: 'OTP_RATE_LIMITED',
        message: 'Bạn đã yêu cầu mã quá nhiều lần. Vui lòng thử lại sau.',
        retryAfterSeconds: perHour.retryAfterSeconds,
      });
    }

    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'status'])
      .where('phone', '=', phone)
      .executeTakeFirst();

    // Số không tồn tại hoặc tài khoản bị khoá: im lặng, vẫn trả "đã gửi".
    if (!identity || identity.status !== 'ACTIVE') {
      this.log.debug(`OTP cho số không dùng được: ${kPhone}`);
      return { sent: true };
    }

    const code = String(randomInt(0, 10 ** MA_SO_CHU_SO)).padStart(MA_SO_CHU_SO, '0');
    const expiresAt = new Date(Date.now() + HAN_DUNG_GIAY * 1000);

    // Mã và tin gửi mã nằm trong CÙNG một transaction: có mã mà không có tin là
    // người dùng chờ vô vọng; có tin mà không có mã là gửi đi một mã không vào được.
    const kenh = await this.db.transaction().execute(async (trx) => {
      // Vô hiệu mọi mã cũ chưa dùng. Nếu không, mã cũ vẫn vào được và số lần thử
      // thực tế nhân lên theo số lần người dùng bấm "gửi lại".
      await trx
        .updateTable('otp_challenge')
        .set({ consumed_at: new Date() })
        .where('phone', '=', phone)
        .where('purpose', '=', 'LOGIN')
        .where('consumed_at', 'is', null)
        .execute();

      const ch = await trx
        .insertInto('otp_challenge')
        .values({ phone, purpose: 'LOGIN', code_hash: this.hash(code), expires_at: expiresAt })
        .returning('id')
        .executeTakeFirstOrThrow();

      // Gửi qua OA của MỘT phòng mà người này là thành viên, có OA đang kết nối
      // và mẫu OTP đã duyệt. Chọn phòng gắn bó gần nhất: tin đến từ phòng họ
      // vừa đăng ký là tin họ nhận ra.
      const phong = await trx
        .selectFrom('tenant_user as tu')
        .innerJoin('tenant as t', 't.id', 'tu.tenant_id')
        .innerJoin('tenant_zalo_oa as z', 'z.tenant_id', 'tu.tenant_id')
        .innerJoin('tenant_zns_template as zt', (j) =>
          j.onRef('zt.tenant_id', '=', 'tu.tenant_id').on('zt.template_code', '=', 'OTP_LOGIN'),
        )
        .select('tu.tenant_id')
        .where('tu.identity_id', '=', identity.id)
        .where('tu.status', '=', 'ACTIVE')
        .where('t.status', 'in', ['TRIAL', 'ACTIVE', 'PAST_DUE'])
        .where('z.status', '=', 'CONNECTED')
        .where('zt.status', '=', 'APPROVED')
        .orderBy('tu.joined_at', 'desc')
        .limit(1)
        .executeTakeFirst();

      // Không phòng nào gửi được qua Zalo: SMS, xếp vào hộp thư của phòng gắn bó
      // gần nhất (tên phòng đứng đầu tin, lượt SMS tính cho phòng đó). Tin Zalo
      // gửi hỏng về sau cũng rơi sang SMS — việc đó ở worker (outbox-dispatcher).
      let kenh: 'ZALO_ZNS' | 'SMS' = 'ZALO_ZNS';
      let tenantId = phong?.tenant_id;
      if (!tenantId && this.sms.enabled) {
        const bk = await trx
          .selectFrom('tenant_user as tu')
          .innerJoin('tenant as t', 't.id', 'tu.tenant_id')
          .select('tu.tenant_id')
          .where('tu.identity_id', '=', identity.id)
          .where('tu.status', '=', 'ACTIVE')
          .where('t.status', 'in', ['TRIAL', 'ACTIVE', 'PAST_DUE'])
          .orderBy('tu.joined_at', 'desc')
          .limit(1)
          .executeTakeFirst();
        tenantId = bk?.tenant_id;
        kenh = 'SMS';
      }
      if (!tenantId) return null;

      const hv = await trx
        .selectFrom('member')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .where('identity_id', '=', identity.id)
        .executeTakeFirst();

      // Mã đi vào outbox ở dạng NIÊM PHONG theo phòng — không bao giờ ở dạng
      // thô, kể cả trong vài giây chờ worker. Worker xoá nó khỏi payload ngay
      // khi tin kết thúc.
      const codeEnc = niemPhong(this.cfg.getOrThrow('TENANT_SECRET_KEY'), tenantId, 'otp.code', code);
      await trx
        .insertInto('notification_outbox')
        .values({
          tenant_id: tenantId,
          channel: kenh,
          template_code: 'OTP_LOGIN',
          recipient_ref: phone,
          member_id: hv?.id ?? null,
          idempotency_key: `OTP:${ch.id}`,
          payload: JSON.stringify({ codeEnc: codeEnc.toString('base64'), expiresAt: expiresAt.toISOString() }),
        })
        .execute();
      return kenh;
    });

    if (!kenh) {
      // Không kênh nào: không phòng nào có OA + mẫu OTP, và SMS chưa cấu hình
      // (hoặc người này không thuộc phòng nào đang hoạt động). Không báo cho
      // người dùng (điểm 3 ở trên) — nhưng phải hiện trong log.
      this.log.warn(`OTP ${kPhone}: không có kênh gửi (không phòng nào có Zalo OA + mẫu OTP_LOGIN, SMS chưa cấu hình)`);
    }
    if (this.laMoiTruongDev) this.log.log(`[DEV] OTP cho ${phone}: ${code}`);

    return this.laMoiTruongDev ? { sent: true, devCode: code } : { sent: true };
  }

  /** Trả về identityId nếu mã đúng. Ném lỗi ở mọi trường hợp còn lại. */
  async verify(phone: string, code: string): Promise<string> {
    const kPhone = phoneKeyPart(phone, (s) => this.hash(s));
    const verdict = await this.rate.hit(globalKey('otp', 'ver', kPhone), 10, 600);
    if (!verdict.allowed) {
      throw new BadRequestException({
        code: 'OTP_RATE_LIMITED',
        message: 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau.',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }

    const challenge = await this.db
      .selectFrom('otp_challenge')
      .select(['id', 'code_hash', 'expires_at', 'attempts'])
      .where('phone', '=', phone)
      .where('purpose', '=', 'LOGIN')
      .where('consumed_at', 'is', null)
      .orderBy('created_at', 'desc')
      .executeTakeFirst();

    const sai = () =>
      new BadRequestException({ code: 'OTP_INVALID', message: 'Mã xác thực không đúng hoặc đã hết hạn' });

    if (!challenge) throw sai();
    if (challenge.expires_at < new Date()) throw sai();

    if (challenge.attempts >= SO_LAN_NHAP_SAI_TOI_DA) {
      await this.db
        .updateTable('otp_challenge')
        .set({ consumed_at: new Date() })
        .where('id', '=', challenge.id)
        .execute();
      throw new BadRequestException({
        code: 'OTP_TOO_MANY_ATTEMPTS',
        message: 'Mã đã bị khoá do nhập sai quá nhiều lần. Vui lòng yêu cầu mã mới.',
      });
    }

    const a = Buffer.from(this.hash(code), 'hex');
    const b = Buffer.from(challenge.code_hash, 'hex');
    const khop = a.length === b.length && timingSafeEqual(a, b);

    if (!khop) {
      // Tăng bộ đếm TRƯỚC khi trả lỗi. Đặt sau là không bao giờ chạy.
      await this.db
        .updateTable('otp_challenge')
        .set({ attempts: challenge.attempts + 1 })
        .where('id', '=', challenge.id)
        .execute();
      throw sai();
    }

    await this.db
      .updateTable('otp_challenge')
      .set({ consumed_at: new Date() })
      .where('id', '=', challenge.id)
      .execute();

    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'status'])
      .where('phone', '=', phone)
      .executeTakeFirst();
    if (!identity || identity.status !== 'ACTIVE') throw sai();

    // Xác thực xong thì quên các lần sai trước.
    await this.rate.reset(globalKey('otp', 'ver', kPhone));

    // Đăng nhập OTP thành công cũng là một lần xác minh số điện thoại.
    await this.db
      .updateTable('identity')
      .set({ phone_verified_at: new Date(), last_login_at: new Date() })
      .where('id', '=', identity.id)
      .execute();

    return identity.id;
  }
}
