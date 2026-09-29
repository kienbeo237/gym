import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { DB } from '@pt/contracts';

/**
 * BA kết nối, BA role, ba mức quyền. Tách ra là điều kiện để RLS có nghĩa.
 *
 *   DB_APP      app_rw       — mọi nghiệp vụ. NOBYPASSRLS, bị RLS áp thật.
 *   DB_AUTH     app_auth     — CHỈ luồng đăng nhập, chạy trước khi có tenant.
 *   DB_PLATFORM app_platform — quản trị nền tảng, nhìn xuyên tenant.
 *
 * Service nghiệp vụ chỉ được nhận DB_APP, và chỉ qua TenantDb. Tiêm thẳng
 * DB_PLATFORM vào một service nghiệp vụ là vô hiệu hoá toàn bộ lớp cách ly.
 * Cổng gác: test/db-access-discipline.spec.ts quét mã nguồn và đỏ nếu ba ký
 * hiệu dưới đây xuất hiện ngoài những tệp được phép.
 */
export const DB_APP = Symbol('DB_APP');
export const DB_AUTH = Symbol('DB_AUTH');
export const DB_PLATFORM = Symbol('DB_PLATFORM');

function makeDb(url: string, max: number): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: url,
        max,
        idleTimeoutMillis: 30_000,
        // Câu lệnh treo sẽ giữ khoá trên member_package và chặn cả luồng điểm
        // danh của phòng đó. Thà vỡ sớm.
        statement_timeout: 15_000,
      }),
    }),
  });
}

@Global()
@Module({
  providers: [
    {
      provide: DB_APP,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => makeDb(c.getOrThrow('DATABASE_URL_APP'), 20),
    },
    {
      provide: DB_AUTH,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => makeDb(c.getOrThrow('DATABASE_URL_AUTH'), 5),
    },
    {
      provide: DB_PLATFORM,
      inject: [ConfigService],
      useFactory: (c: ConfigService) => makeDb(c.getOrThrow('DATABASE_URL_PLATFORM'), 3),
    },
  ],
  exports: [DB_APP, DB_AUTH, DB_PLATFORM],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor() {}
  async onApplicationShutdown(): Promise<void> {
    // Pool tự đóng theo tiến trình; giữ hook để nơi này là chỗ dọn tài nguyên
    // khi thêm read-replica về sau.
  }
}
