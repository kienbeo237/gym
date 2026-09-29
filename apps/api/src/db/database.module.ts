import { Global, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { DB } from '@pt/contracts';

/**
 * Cột `date` của Postgres KHÔNG có múi giờ — nó là một ngày trên tờ lịch, không
 * phải một thời điểm. Mặc định node-postgres dựng nó thành `Date` ở NỬA ĐÊM GIỜ
 * MÁY CHỦ, và từ đó mọi cách quy về chuỗi đều sai một kiểu:
 *
 *   `String(d)`            -> "Sat Nov 28 2026 00:00:00 GMT+0700"  (sai định dạng)
 *   `d.toISOString()`      -> "2026-11-27T17:00:00Z"               (LÙI MỘT NGÀY)
 *
 * Cái thứ hai nguy hiểm hơn hẳn: nó vẫn ra một ngày hợp lệ, chỉ là sai. Hạn
 * đóng tiền, ngày hết hạn gói, ngày hiệu lực chính sách hoa hồng đều là cột
 * `date`, và lệch một ngày ở đó là lệch tiền.
 *
 * Giữ nguyên chuỗi 'YYYY-MM-DD' mà Postgres trả về là cách duy nhất không có
 * chỗ cho múi giờ chen vào. `timestamptz` thì vẫn để thành Date như thường —
 * nó thật sự là một thời điểm.
 */
types.setTypeParser(types.builtins.DATE, (v) => v);

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
