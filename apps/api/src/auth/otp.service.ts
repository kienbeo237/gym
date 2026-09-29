import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Kysely } from 'kysely';
import type { DB } from '@pt/contracts';
import { DB_AUTH } from '../db/database.module';
import { RateLimitService } from '../redis/rate-limit.service';
import { globalKey, phoneKeyPart } from '../redis/redis-keys';

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

    // Vô hiệu mọi mã cũ chưa dùng. Nếu không, mã cũ vẫn vào được và số lần thử
    // thực tế nhân lên theo số lần người dùng bấm "gửi lại".
    await this.db
      .updateTable('otp_challenge')
      .set({ consumed_at: new Date() })
      .where('phone', '=', phone)
      .where('purpose', '=', 'LOGIN')
      .where('consumed_at', 'is', null)
      .execute();

    await this.db
      .insertInto('otp_challenge')
      .values({
        phone,
        purpose: 'LOGIN',
        code_hash: this.hash(code),
        expires_at: new Date(Date.now() + HAN_DUNG_GIAY * 1000),
      })
      .execute();

    // TODO(phase 6): đẩy vào notification_outbox để worker gửi qua Zalo OA / SMS.
    // Tới lúc đó, ghi outbox trong CÙNG transaction với INSERT ở trên.
    this.log.log(`[DEV] OTP cho ${phone}: ${code}`);

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
