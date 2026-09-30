import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { Kysely, sql, type Transaction } from 'kysely';
import type { DB, PlatformLevel } from '@pt/contracts';
import { DB_PLATFORM } from '../db/database.module';
import { duCapNenTang } from '../common/auth.guard';
import { SAAS_GRACE_DAYS, SAAS_LEAD_DAYS } from '../common/saas-policy';

export type PTx = Transaction<DB>;

/**
 * Tám view đối soát (0003–0012). Mỗi view liệt kê dòng LỆCH giữa một con số
 * cache và sổ gốc của nó — phải luôn rỗng. reconciliation.spec.ts kiểm cùng
 * danh sách này trong build; job worker kiểm trên dữ liệu thật.
 */
export const VIEW_DOI_SOAT = [
  'v_session_balance_drift',
  'v_invoice_paid_drift',
  'v_sale_commission_drift',
  'v_commission_needs_policy',
  'v_revenue_drift',
  'v_teach_commission_drift',
  'v_revenue_over_contract',
  'v_payroll_drift',
] as const;

const MAU_TOI_DA = 5;

/** Người đang thao tác — lấy từ token phiên nền tảng, KHÔNG từ body. */
export type PlatformActor = { identityId: string; ip: string | null };

export type AuditEntry = {
  /** Tên hành động, dạng `nhóm.việc` (tenant.list, invoice.confirm...). */
  action: string;
  tenantId?: string | null;
  detail?: Record<string, unknown>;
};

/**
 * CỬA DUY NHẤT tới kết nối app_platform (BYPASSRLS, nhìn mọi phòng tập).
 *
 * Mọi lời gọi đi qua `run()`, và `run()` làm ba việc trong MỘT transaction:
 *
 *   1. tra lại platform_admin: access token sống 15 phút, người vừa bị thu
 *      quyền (hoặc hạ cấp) không được dùng nốt phần còn lại của nó. Cấp được
 *      so là cấp ĐANG CÓ trong CSDL, không phải cấp ghi trong token.
 *   2. chạy thao tác
 *   3. ghi platform_audit_log — KỂ CẢ thao tác chỉ đọc
 *
 * Nhật ký nằm cùng transaction với thao tác: thao tác thành công mà nhật ký
 * không ghi được thì cả hai cùng rollback. Không có đường nào đọc dữ liệu xuyên
 * phòng mà không để lại dấu. Và app_platform không UPDATE/DELETE được nhật ký
 * (0016), nên dấu đó không xoá được bằng chính quyền đã để lại nó.
 *
 * Cổng gác: test/db-access-discipline.spec.ts — DB_PLATFORM chỉ được xuất hiện
 * ở tệp này (và nơi khai báo nó).
 */
@Injectable()
export class PlatformDb {
  constructor(@Inject(DB_PLATFORM) private readonly db: Kysely<DB>) {}

  async run<T>(
    actor: PlatformActor,
    need: PlatformLevel,
    audit: AuditEntry | ((kq: T) => AuditEntry),
    fn: (tx: PTx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const pa = await tx
        .selectFrom('platform_admin')
        .select('level')
        .where('identity_id', '=', actor.identityId)
        .executeTakeFirst();
      if (!pa || !duCapNenTang(pa.level, need)) {
        throw new ForbiddenException({
          code: 'PLATFORM_ACCESS_REVOKED',
          message: 'Tài khoản của bạn không (còn) đủ quyền cho thao tác này.',
        });
      }

      const kq = await fn(tx);

      const a = typeof audit === 'function' ? audit(kq) : audit;
      await tx
        .insertInto('platform_audit_log')
        .values({
          actor_id: actor.identityId,
          target_tenant: a.tenantId ?? null,
          action: a.action,
          detail: JSON.stringify(a.detail ?? {}),
          ip: actor.ip,
        })
        .execute();
      return kq;
    });
  }

  /**
   * Job vòng đời thuê bao (worker, mỗi giờ). Không có người thao tác: hàm SQL
   * tự ghi nhật ký cho TỪNG chuyển trạng thái với actor NULL.
   */
  /**
   * Webhook ngân hàng. Cũng không có người thao tác: saas_ingest_bank_txn (0017)
   * tự ghi nhật ký với actor NULL. Chạy lặp với cùng mã giao dịch = một lần.
   */
  async ingestBankTxn(t: {
    provider: string;
    txnId: string;
    direction: 'IN' | 'OUT';
    amount: number;
    content: string;
    accountNo: string | null;
    bankRef: string | null;
    txnAt: string | null;
    payload: unknown;
  }): Promise<{ eventId: number; outcome: string; invoiceId: string | null; duplicate: boolean }> {
    const { rows } = await sql<{ r: { eventId: number; outcome: string; invoiceId: string | null; duplicate: boolean } }>`
      SELECT saas_ingest_bank_txn(${t.provider}, ${t.txnId}, ${t.direction}, ${t.amount}::bigint, ${t.content},
        ${t.accountNo}, ${t.bankRef}, ${t.txnAt}::timestamptz, ${JSON.stringify(t.payload)}::jsonb) AS r
    `.execute(this.db);
    return rows[0]!.r;
  }

  /**
   * Chạy tám view đối soát trên MỌI phòng (app_platform, không qua RLS — lệch
   * dữ liệu là lỗi hệ thống, không phải việc của từng phòng) và ghi một dòng
   * reconciliation_run. Mỗi view một câu lệnh riêng: một view lỗi không che
   * kết quả của bảy view còn lại.
   */
  async reconcile(): Promise<{ total: number; counts: Record<string, number>; errors: Record<string, string> }> {
    const t0 = Date.now();
    const counts: Record<string, number> = {};
    const samples: Record<string, unknown[]> = {};
    const errors: Record<string, string> = {};
    for (const v of VIEW_DOI_SOAT) {
      try {
        const n = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(v)}`.execute(this.db);
        counts[v] = Number(n.rows[0]?.n ?? 0);
        if (counts[v] > 0) {
          const mau = await sql<Record<string, unknown>>`SELECT * FROM ${sql.table(v)} LIMIT ${MAU_TOI_DA}`.execute(this.db);
          samples[v] = mau.rows;
        }
      } catch (e) {
        errors[v] = String(e instanceof Error ? e.message : e).slice(0, 300);
      }
    }
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    await this.db
      .insertInto('reconciliation_run')
      .values({
        counts: JSON.stringify(counts),
        total,
        samples: JSON.stringify(samples),
        errors: JSON.stringify(errors),
        duration_ms: Date.now() - t0,
      })
      .execute();
    return { total, counts, errors };
  }

  async lifecycleTick(): Promise<Record<string, number>> {
    const { rows } = await sql<{ r: Record<string, number> }>`
      SELECT saas_lifecycle_tick(
        (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, ${SAAS_LEAD_DAYS}::int, ${SAAS_GRACE_DAYS}::int) AS r
    `.execute(this.db);
    return rows[0]?.r ?? {};
  }
}
