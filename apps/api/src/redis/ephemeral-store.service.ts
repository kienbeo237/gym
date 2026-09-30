import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS } from './redis.tokens';

/**
 * Giá trị ngắn hạn dùng MỘT LẦN (PKCE verifier của luồng kết nối Zalo).
 *
 * Nằm trong src/redis/ để cổng gác khoá Redis soi được: bên gọi truyền khoá đã
 * dựng bằng tenantKey()/globalKey(), service này không tự dựng khoá nào.
 *
 * KHÁC RateLimitService ở chỗ KHÔNG fail-open: không đọc được Redis thì luồng
 * kết nối phải hỏng rõ ràng, không được coi như "không có gì" rồi đi tiếp.
 */
@Injectable()
export class EphemeralStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async put(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  /**
   * Lấy rồi xoá NGUYÊN TỬ — hai request cùng dùng một `state` thì chỉ một cái thắng.
   *
   * MULTI thay vì GETDEL: cùng một bảo đảm, nhưng GETDEL cần Redis ≥ 6.2 còn
   * máy dev Windows hay chạy bản cũ hơn.
   */
  async take(key: string): Promise<string | null> {
    const kq = await this.redis.multi().get(key).del(key).exec();
    if (!kq) throw new Error('Redis huỷ giao dịch MULTI');
    const [loi, giaTri] = kq[0]!;
    if (loi) throw loi;
    return giaTri as string | null;
  }
}
