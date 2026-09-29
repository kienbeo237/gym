import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { Kysely, type Transaction } from 'kysely';
import type { DB } from '@pt/contracts';
import { DB_APP } from '../db/database.module';
import { currentContext } from './tenant-context';

export type Tx = Transaction<DB>;

/**
 * ĐIỂM VÀO DUY NHẤT cho mọi truy vấn nghiệp vụ.
 *
 * Mở một transaction, đặt app.tenant_id bằng set_config(..., TRUE) rồi trao
 * transaction đó cho lời gọi. Mọi câu lệnh bên trong đều bị RLS lọc theo đúng
 * tenant của token.
 *
 * BA ĐIỀU KHÔNG ĐƯỢC ĐỔI:
 *
 *  1. Tham số thứ ba của set_config là TRUE = SET LOCAL, chỉ sống trong
 *     transaction. Dùng FALSE (hoặc `SET`) thì biến sống hết đời KẾT NỐI, mà
 *     pool tái sử dụng kết nối — request sau của tenant khác kế thừa giá trị cũ
 *     và đọc nhầm dữ liệu. Đây là cách rò tenant kinh điển nhất và nó không ném
 *     lỗi ở đâu cả.
 *
 *  2. Đặt tenant NGAY câu lệnh đầu transaction, trước mọi câu khác.
 *
 *  3. Không có đường vòng. Service nghiệp vụ không được tiêm Kysely thẳng;
 *     tiêm thẳng là bỏ qua bước set_config và mọi query trả về 0 dòng — lỗi
 *     trông như "mất dữ liệu" chứ không như "thiếu phân quyền", nên rất tốn
 *     thời gian truy.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(DB_APP) private readonly db: Kysely<DB>) {}

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = currentContext();
    if (!ctx?.tenantId) {
      throw new InternalServerErrorException({
        code: 'TENANT_CONTEXT_MISSING',
        message: 'Yêu cầu chạy ngoài ngữ cảnh phòng tập',
      });
    }
    return this.runAs(ctx.tenantId, fn);
  }

  /**
   * Chạy với một tenant chỉ định. Dùng cho worker nền (campaign, outbox) — nơi
   * không có request nào nên AsyncLocalStorage rỗng, và tenant đến từ payload
   * của job.
   */
  async runAs<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectNoFrom((eb) => eb.fn<string>('set_config', [
          eb.val('app.tenant_id'),
          eb.val(tenantId),
          eb.val(true),
        ]).as('ok'))
        .executeTakeFirstOrThrow();
      return fn(tx);
    });
  }
}
