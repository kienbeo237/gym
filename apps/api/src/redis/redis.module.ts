import { Global, Module, Logger, type OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RateLimitService } from './rate-limit.service';
import { EphemeralStore } from './ephemeral-store.service';
import { REDIS } from './redis.tokens';

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => {
        const log = new Logger('Redis');
        const client = new Redis({
          host: c.get('REDIS_HOST') ?? 'localhost',
          port: Number(c.get('REDIS_PORT') ?? 6379),
          password: c.get('REDIS_PASSWORD'),
          // Không thử lại vô hạn: một lệnh treo trong đường xử lý request sẽ
          // giữ luôn transaction CSDL đang mở.
          maxRetriesPerRequest: 2,
          connectTimeout: 3_000,
          lazyConnect: false,
          retryStrategy: (times) => Math.min(times * 200, 3_000),
        });
        client.on('error', (e) => log.warn(`Redis: ${e.message}`));
        client.on('ready', () => log.log('Redis sẵn sàng'));
        return client;
      },
    },
    RateLimitService,
    EphemeralStore,
  ],
  exports: [REDIS, RateLimitService, EphemeralStore],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
