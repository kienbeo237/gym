import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  DashboardResponse,
  MonthFigures,
  PackageReportRow,
  TrainerReportRow,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { RateLimitService } from '../redis/rate-limit.service';
import { tenantKey } from '../redis/redis-keys';

const TZ = 'Asia/Ho_Chi_Minh';

/** Tháng hiện tại theo GIỜ VIỆT NAM, dạng `YYYY-MM`. */
function thangVN(offset = 0): string {
  const hn = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
  const d = new Date(`${hn.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + offset);
  return d.toISOString().slice(0, 7);
}

const RONG: Omit<MonthFigures, 'month'> = {
  cashIn: 0, cashOut: 0, netCash: 0, revenueRecognized: 0, grossSales: 0,
  packagesSold: 0, newMembers: 0, sessionsTaught: 0, sessionsDeducted: 0,
};

/**
 * Báo cáo đọc từ materialized view, KHÔNG từ bảng gốc.
 *
 * Nhưng không đọc thẳng matview: PostgreSQL không cho bật RLS trên matview, nên
 * app_rw bị REVOKE khỏi chúng và chỉ đọc được qua các view bọc `v_*_month` có
 * mệnh đề tenant (migration 0012). Đọc thẳng sẽ bị từ chối quyền — đó là ý đồ.
 *
 * Những con số KHÔNG tổng hợp trước (công nợ, doanh thu chưa ghi nhận, gói sắp
 * hết) đọc từ bảng gốc: chúng là trạng thái TẠI THỜI ĐIỂM XEM, không phải số
 * liệu của một tháng, nên đưa vào matview là sai ngay từ ý nghĩa.
 */
@Injectable()
export class ReportService {
  private readonly log = new Logger(ReportService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly rate: RateLimitService,
  ) {}

  async dashboard(month?: string): Promise<DashboardResponse> {
    const thangNay = month ?? thangVN(0);
    const d = new Date(`${thangNay}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const thangTruoc = d.toISOString().slice(0, 7);

    return this.tdb.run(async (tx) => {
      const [figs, congNo, chuaGhiNhan, hoiVien, sapHet] = await Promise.all([
        this.layThang(tx, [thangNay, thangTruoc]),
        this.congNo(tx),
        this.doanhThuChuaGhiNhan(tx),
        tx
          .selectFrom('member')
          .select((eb) => eb.fn.countAll<string>().as('c'))
          .where('status', '=', 'ACTIVE')
          .executeTakeFirstOrThrow(),
        this.gapHan(tx),
      ]);

      return {
        current: figs.get(thangNay) ?? { month: thangNay, ...RONG },
        previous: figs.get(thangTruoc) ?? { month: thangTruoc, ...RONG },
        outstanding: congNo,
        deferredRevenue: chuaGhiNhan,
        activeMembers: Number(hoiVien.c),
        expiringSoon: sapHet.hetHan,
        lowBalance: sapHet.hetBuoi,
        refreshedAt: await this.lanLamMoiCuoi(tx),
      };
    });
  }

  async trainers(month?: string): Promise<TrainerReportRow[]> {
    const thang = month ?? thangVN(0);

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('trainer as t')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .leftJoin('v_trainer_month as m', (join) =>
          join
            .onRef('m.trainer_id', '=', 't.id')
            .on('m.period_month', '=', `${thang}-01`),
        )
        .select((eb) => [
          't.id', 't.code', 't.base_salary as baseSalary',
          'i.full_name as fullName',
          'm.sessions_taught as sessionsTaught',
          'm.sessions_deducted as sessionsDeducted',
          'm.revenue_recognized as revenueRecognized',
          'm.commission_sale as commissionSale',
          'm.commission_teach as commissionTeach',
          eb
            .selectFrom('member_package as mp')
            .select((e) => e.fn.count<string>('mp.member_id').distinct().as('c'))
            .whereRef('mp.trainer_id', '=', 't.id')
            .where('mp.status', '=', 'ACTIVE')
            .as('activeMembers'),
        ])
        .where('t.status', '=', 'ACTIVE')
        .orderBy('t.code')
        .execute();

      return rows.map((r) => {
        const ban = Number(r.commissionSale ?? 0);
        const day = Number(r.commissionTeach ?? 0);
        return {
          trainerId: r.id,
          trainerCode: r.code,
          trainerName: r.fullName,
          sessionsTaught: Number(r.sessionsTaught ?? 0),
          sessionsDeducted: Number(r.sessionsDeducted ?? 0),
          revenueRecognized: Number(r.revenueRecognized ?? 0),
          commissionSale: ban,
          commissionTeach: day,
          commissionTotal: ban + day,
          baseSalary: Number(r.baseSalary),
          estimatedPay: Number(r.baseSalary) + ban + day,
          activeMembers: Number(r.activeMembers ?? 0),
        };
      });
    });
  }

  async packages(month?: string): Promise<PackageReportRow[]> {
    const thang = month ?? thangVN(0);

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('v_package_month as m')
        .innerJoin('package_template as p', 'p.id', 'm.template_id')
        .select([
          'p.id as templateId', 'p.code', 'p.name',
          'm.sold_count as soldCount', 'm.gross_amount as grossAmount',
          'm.discount_amount as discountAmount', 'm.net_amount as netAmount',
          'm.sessions_sold as sessionsSold', 'm.sessions_used as sessionsUsed',
        ])
        .where('m.period_month', '=', `${thang}-01`)
        .orderBy('m.net_amount', 'desc')
        .execute();

      return rows.map((r) => {
        const ban = Number(r.sessionsSold ?? 0);
        return {
          templateId: r.templateId,
          code: r.code,
          name: r.name,
          soldCount: Number(r.soldCount),
          grossAmount: Number(r.grossAmount),
          discountAmount: Number(r.discountAmount),
          netAmount: Number(r.netAmount),
          sessionsSold: ban,
          sessionsUsed: Number(r.sessionsUsed ?? 0),
          usageRate: ban === 0 ? 0 : Math.round((Number(r.sessionsUsed ?? 0) / ban) * 1000) / 10,
        };
      });
    });
  }

  /**
   * Làm mới số liệu tổng hợp.
   *
   * Hàm ở CSDL là SECURITY DEFINER và làm mới cho MỌI phòng tập cùng lúc —
   * matview là một khối. Vì thế phải giới hạn tần suất: một phòng bấm liên tục
   * sẽ làm nặng cả hệ thống. Đường đúng về lâu dài là job định kỳ, không phải
   * nút bấm.
   */
  async refresh(): Promise<{ refreshed: boolean; retryAfterSeconds: number }> {
    const ctx = requireContext();
    const verdict = await this.rate.hit(tenantKey(ctx.tenantId, 'report', 'refresh'), 1, 300);
    if (!verdict.allowed) {
      return { refreshed: false, retryAfterSeconds: verdict.retryAfterSeconds };
    }
    await this.tdb.run(async (tx) => {
      await sql`SELECT refresh_reporting()`.execute(tx);
    });
    this.log.log(`Đã làm mới báo cáo (yêu cầu từ phòng ${ctx.tenantId})`);
    return { refreshed: true, retryAfterSeconds: 0 };
  }

  // -------------------------------------------------------------------------

  private async layThang(tx: Tx, thang: string[]): Promise<Map<string, MonthFigures>> {
    const rows = await tx
      .selectFrom('v_tenant_month')
      .selectAll()
      .where('period_month', 'in', thang.map((t) => `${t}-01`))
      .execute();

    return new Map(
      rows.map((r) => {
        const vao = Number(r.cash_in);
        const ra = Number(r.cash_out);
        const m = String(r.period_month).slice(0, 7);
        return [
          m,
          {
            month: m,
            cashIn: vao,
            cashOut: ra,
            netCash: vao - ra,
            revenueRecognized: Number(r.revenue_recognized),
            grossSales: Number(r.gross_sales),
            packagesSold: Number(r.packages_sold),
            newMembers: Number(r.new_members),
            sessionsTaught: Number(r.sessions_taught),
            sessionsDeducted: Number(r.sessions_deducted),
          },
        ];
      }),
    );
  }

  /** Công nợ là TRẠNG THÁI hiện tại, không phải số liệu của một tháng. */
  private async congNo(tx: Tx) {
    const r = await sql<{ amount: string; invoices: string; overdue: string }>`
      SELECT COALESCE(SUM(i.total_amount - i.paid_amount), 0)::text AS amount,
             count(*)::text AS invoices,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM payment_schedule ps
               WHERE ps.invoice_id = i.id
                 AND ps.status IN ('DUE','OVERDUE') AND ps.due_date < current_date))::text AS overdue
      FROM invoice i
      WHERE i.status IN ('OPEN','PARTIALLY_PAID')`.execute(tx);
    const row = r.rows[0]!;
    return {
      amount: Number(row.amount),
      invoiceCount: Number(row.invoices),
      overdueCount: Number(row.overdue),
    };
  }

  /**
   * Doanh thu CHƯA ghi nhận = tiền đã thu cho những buổi chưa tập.
   *
   * Đây là NGHĨA VỤ, không phải tài sản: nếu khách đòi hoàn tiền ngày mai thì
   * đây là số phải trả lại. Chủ phòng cần thấy nó cạnh con số "đã thu", nếu
   * không sẽ tiêu vào tiền của những buổi chưa dạy.
   */
  private async doanhThuChuaGhiNhan(tx: Tx) {
    const r = await sql<{ amount: string; sessions: string }>`
      SELECT COALESCE(SUM(GREATEST(
               LEAST(mp.price_net, i.paid_amount) - COALESCE(re.da_ghi, 0), 0)), 0)::text AS amount,
             COALESCE(SUM(mp.sessions_remaining), 0)::text AS sessions
      FROM member_package mp
      JOIN invoice_item ii ON ii.member_package_id = mp.id
      JOIN invoice i       ON i.id = ii.invoice_id AND i.status <> 'VOID'
      LEFT JOIN LATERAL (
        SELECT SUM(r2.amount) AS da_ghi FROM revenue_entry r2
        WHERE r2.member_package_id = mp.id
      ) re ON true
      WHERE mp.status = 'ACTIVE'`.execute(tx);
    const row = r.rows[0]!;
    return { amount: Number(row.amount), sessionsOutstanding: Number(row.sessions) };
  }

  private async gapHan(tx: Tx) {
    const r = await sql<{ het_han: string; het_buoi: string }>`
      SELECT count(*) FILTER (WHERE mp.expires_on <= current_date + 14)::text AS het_han,
             count(*) FILTER (WHERE mp.sessions_remaining <= 3)::text          AS het_buoi
      FROM member_package mp WHERE mp.status = 'ACTIVE'`.execute(tx);
    return { hetHan: Number(r.rows[0]!.het_han), hetBuoi: Number(r.rows[0]!.het_buoi) };
  }

  /**
   * Thời điểm matview được làm mới lần cuối.
   *
   * Phải nói ra trên màn hình: số liệu tổng hợp có độ trễ, và người dùng đối
   * chiếu với màn hoá đơn (đọc bảng gốc, luôn tức thời) sẽ thấy lệch. Không
   * hiển thị mốc này thì họ tưởng hệ thống sai.
   */
  private async lanLamMoiCuoi(tx: Tx): Promise<string | null> {
    // Mốc do chính `refresh_reporting()` ghi (migration 0013). PostgreSQL không
    // lưu thời điểm REFRESH, và suy từ `pg_stat_get_last_analyze_time` là xấp xỉ
    // sai — autovacuum chạy độc lập nên con số sẽ lúc đúng lúc sai không quy luật.
    const r = await tx
      .selectFrom('reporting_refresh_log')
      .select('refreshed_at')
      .orderBy('refreshed_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return r ? new Date(r.refreshed_at).toISOString() : null;
  }
}
