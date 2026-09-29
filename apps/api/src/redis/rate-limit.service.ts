import { Inject, Injectable, Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './redis.tokens';

export type RateVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/**
 * Giới hạn tần suất bằng cửa sổ cố định (INCR + EXPIRE).
 *
 * Chọn cửa sổ cố định thay vì trượt: nó là HAI lệnh Redis, không cần Lua, và
 * sai số tệ nhất là cho qua gấp đôi hạn mức ở ranh giới cửa sổ. Với gửi OTP và
 * đăng nhập thì sai số đó vô hại; với thứ gì tính tiền thì mới cần cửa sổ trượt.
 *
 * FAIL-OPEN khi Redis chết, CÓ CHỦ ĐÍCH: đây là lớp chống lạm dụng, không phải
 * lớp phân quyền. Redis sập mà chặn hết đăng nhập là tự gây sự cố lớn hơn thứ
 * đang phòng. Lưới an toàn nằm ở CSDL — `otp_challenge` có chỉ mục ix_otp_rate
 * để đếm lại, và số lần nhập sai vẫn nằm trên chính bản ghi OTP.
 */
@Injectable()
export class RateLimitService {
  private readonly log = new Logger(RateLimitService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateVerdict> {
    try {
      const [[, countRaw], [, ttlRaw]] = (await this.redis
        .multi()
        .incr(key)
        .ttl(key)
        .exec()) as [[Error | null, number], [Error | null, number]];

      const count = Number(countRaw);
      // TTL < 0 nghĩa là khoá vừa được tạo bởi chính INCR ở trên và chưa có hạn.
      if (Number(ttlRaw) < 0) await this.redis.expire(key, windowSeconds);

      const remaining = Math.max(0, limit - count);
      return {
        allowed: count <= limit,
        remaining,
        retryAfterSeconds: count <= limit ? 0 : Math.max(1, Number(ttlRaw)),
      };
    } catch (e) {
      this.log.warn(`Redis lỗi, bỏ qua giới hạn tần suất cho ${key}: ${String(e)}`);
      return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
    }
  }

  /** Xoá bộ đếm sau khi thao tác thành công (đăng nhập đúng thì quên lần sai cũ). */
  async reset(key: string): Promise<void> {
    await this.redis.del(key).catch(() => undefined);
  }

  /**
   * Khoá phân tán, dùng cho việc chỉ được chạy một lần: làm mới token Zalo OA,
   * chạy chiến dịch hằng ngày, refresh materialized view.
   *
   * Trả về hàm nhả khoá, hoặc null nếu người khác đang giữ. Khoá tự hết hạn nên
   * tiến trình chết giữa chừng không treo vĩnh viễn.
   */
  async acquire(key: string, ttlSeconds: number): Promise<(() => Promise<void>) | null> {
    const token = `${process.pid}-${Date.now()}-${Math.random()}`;
    const ok = await this.redis.set(key, token, 'EX', ttlSeconds, 'NX');
    if (ok !== 'OK') return null;
    return async () => {
      // So giá trị trước khi xoá: khoá có thể đã hết hạn và được người khác
      // giành. Xoá mù là xoá khoá của người đang chạy.
      const current = await this.redis.get(key).catch(() => null);
      if (current === token) await this.redis.del(key).catch(() => undefined);
    };
  }
}
