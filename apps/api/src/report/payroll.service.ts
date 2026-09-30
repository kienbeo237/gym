import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { ClosePayrollRequest, PayrollLine, PayrollResponse, PayrollStatus, ReopenPayrollRequest } from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

const dauThang = (thang: string) => `${thang}-01`;

/**
 * Bảng lương huấn luyện viên.
 *
 * Bất biến quan trọng nhất: **một dòng hoa hồng thuộc tối đa một bảng lương**.
 * Đó là thứ chặn trả hai lần, và nó được ép bằng cột
 * `commission_entry.payroll_line_id` chứ không bằng phép kiểm ở service.
 *
 * Chốt lương là hành động ĐÓNG BĂNG: `base_salary` được chụp ảnh, và các con số
 * hoa hồng được ghi cứng vào `payroll_line`. Sửa chính sách hoa hồng hay lương
 * cứng tháng sau không được làm đổi bảng lương đã chốt.
 */
@Injectable()
export class PayrollService {
  constructor(private readonly tdb: TenantDb) {}

  /**
   * Xem bảng lương một tháng. Chưa chốt thì TÍNH TẠM từ hoa hồng chưa trả;
   * đã chốt thì đọc đúng con số đã đóng băng.
   */
  async view(thang: string): Promise<PayrollResponse> {
    return this.tdb.run(async (tx) => {
      const run = await tx
        .selectFrom('payroll_run')
        .select(['id', 'status', 'closed_at', 'paid_at'])
        .where('period_month', '=', dauThang(thang))
        .executeTakeFirst();

      if (run) {
        const lines = await tx
          .selectFrom('payroll_line as pl')
          .innerJoin('trainer as t', 't.id', 'pl.trainer_id')
          .innerJoin('identity as i', 'i.id', 't.identity_id')
          .select([
            'pl.id', 'pl.trainer_id as trainerId', 't.code as trainerCode',
            'i.full_name as trainerName', 'pl.base_salary as baseSalary',
            'pl.commission_sale as commissionSale', 'pl.commission_teach as commissionTeach',
            'pl.adjustment', 'pl.adjustment_note as adjustmentNote',
            'pl.total', 'pl.sessions_taught as sessionsTaught',
          ])
          .where('pl.run_id', '=', run.id)
          .orderBy('t.code')
          .execute();

        const items: PayrollLine[] = lines.map((l) => ({
          id: l.id,
          trainerId: l.trainerId,
          trainerCode: l.trainerCode,
          trainerName: l.trainerName,
          baseSalary: Number(l.baseSalary),
          commissionSale: Number(l.commissionSale),
          commissionTeach: Number(l.commissionTeach),
          adjustment: Number(l.adjustment),
          adjustmentNote: l.adjustmentNote,
          total: Number(l.total),
          sessionsTaught: l.sessionsTaught,
        }));

        return {
          month: thang,
          status: run.status as PayrollStatus,
          runId: run.id,
          closedAt: run.closed_at ? new Date(run.closed_at).toISOString() : null,
          paidAt: run.paid_at ? new Date(run.paid_at).toISOString() : null,
          lines: items,
          totalPayout: items.reduce((s, x) => s + x.total, 0),
          carriedOver: { amount: 0, entryCount: 0 },
        };
      }

      const tam = await this.tinhTam(tx, thang);
      return {
        month: thang,
        status: 'DRAFT',
        runId: null,
        closedAt: null,
        paidAt: null,
        lines: tam.lines,
        totalPayout: tam.lines.reduce((s, x) => s + x.total, 0),
        carriedOver: tam.carriedOver,
      };
    });
  }

  /**
   * Chốt bảng lương.
   *
   * Cuốn MỌI dòng hoa hồng chưa trả có `period_month <= tháng chốt`, không chỉ
   * đúng tháng đó. Lý do: một lần thu tiền ghi lùi ngày (hoặc một buổi tập nhập
   * bù) sinh hoa hồng thuộc tháng đã chốt xong. Nếu chỉ lấy đúng tháng thì
   * khoản đó không bao giờ được trả — nó rơi vào một tháng vĩnh viễn đã đóng.
   */
  async close(dto: ClosePayrollRequest): Promise<PayrollResponse> {
    const ctx = requireContext();

    await this.tdb.run(async (tx) => {
      // Khoá theo (tenant, tháng): hai người bấm chốt cùng lúc thì người sau
      // chờ, thay vì cả hai cùng cuốn một tập hoa hồng.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':payroll:' || ${dto.month}))`.execute(tx);

      const daCo = await tx
        .selectFrom('payroll_run')
        .select(['id', 'status'])
        .where('period_month', '=', dauThang(dto.month))
        .executeTakeFirst();
      if (daCo) {
        throw new BadRequestException({
          code: 'PAYROLL_ALREADY_EXISTS',
          message: `Bảng lương tháng ${dto.month} đã được chốt (${daCo.status})`,
        });
      }

      const run = await tx
        .insertInto('payroll_run')
        .values({
          tenant_id: ctx.tenantId,
          period_month: dauThang(dto.month),
          status: 'CLOSED',
          closed_at: new Date(),
          closed_by: ctx.identityId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const dieuChinh = new Map(dto.adjustments.map((a) => [a.trainerId, a]));

      // Lấy hoa hồng CHƯA thuộc bảng lương nào, thuộc tháng này trở về trước.
      const tong = await tx
        .selectFrom('commission_entry as ce')
        .select((eb) => [
          'ce.trainer_id as trainerId',
          eb.fn.coalesce(eb.fn.sum<string>(sql`CASE WHEN ce.kind='SALE' THEN ce.amount ELSE 0 END`), eb.val('0')).as('ban'),
          eb.fn.coalesce(eb.fn.sum<string>(sql`CASE WHEN ce.kind='TEACH' THEN ce.amount ELSE 0 END`), eb.val('0')).as('day'),
          eb.fn.count<string>(sql`CASE WHEN ce.kind='TEACH' THEN 1 END`).as('soBuoi'),
        ])
        .where('ce.payroll_line_id', 'is', null)
        .where('ce.period_month', '<=', dauThang(dto.month))
        .groupBy('ce.trainer_id')
        .execute();

      const theoPt = new Map(tong.map((r) => [r.trainerId, r]));

      const pts = await tx
        .selectFrom('trainer')
        .select(['id', 'base_salary'])
        .where('status', '=', 'ACTIVE')
        .execute();

      // Huấn luyện viên đã nghỉ nhưng còn hoa hồng chưa trả vẫn phải có dòng.
      const tatCa = new Set([...pts.map((p) => p.id), ...theoPt.keys()]);

      for (const trainerId of tatCa) {
        const c = theoPt.get(trainerId);
        const pt = pts.find((p) => p.id === trainerId);
        const adj = dieuChinh.get(trainerId);

        const luongCung = pt
          ? Number(pt.base_salary)
          : // Đã nghỉ: không trả lương cứng, chỉ trả nốt hoa hồng.
            0;

        const line = await tx
          .insertInto('payroll_line')
          .values({
            tenant_id: ctx.tenantId,
            run_id: run.id,
            trainer_id: trainerId,
            base_salary: luongCung,
            commission_sale: Number(c?.ban ?? 0),
            commission_teach: Number(c?.day ?? 0),
            adjustment: adj?.amount ?? 0,
            adjustment_note: adj?.note ?? null,
            sessions_taught: Number(c?.soBuoi ?? 0),
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        // Gắn hoa hồng vào dòng lương. Sau bước này chúng không thể vào bảng
        // lương nào khác — `payroll_line_id` khác NULL loại chúng khỏi truy vấn
        // trên ở mọi lần chốt sau.
        await tx
          .updateTable('commission_entry')
          .set({ payroll_line_id: line.id })
          .where('trainer_id', '=', trainerId)
          .where('payroll_line_id', 'is', null)
          .where('period_month', '<=', dauThang(dto.month))
          .execute();
      }

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'PAYROLL_CLOSED',
          entity: 'payroll_run',
          entity_id: run.id,
          after: JSON.stringify({ month: dto.month, trainers: tatCa.size }),
        })
        .execute();
    });

    return this.view(dto.month);
  }

  /**
   * Mở lại bảng lương đã chốt nhầm. Xoá payroll_run -> payroll_line (CASCADE)
   * -> commission_entry.payroll_line_id về NULL (ON DELETE SET NULL): mọi dòng
   * hoa hồng quay lại "chưa trả" và lần chốt sau cuốn lại chúng. Không số nào
   * bị sửa tay.
   *
   * Ba chặn:
   *  - Đã CHI (PAID) thì không mở: tiền đã ra khỏi két, đảo ngược là việc kế
   *    toán (điều chỉnh ở tháng sau), không phải bấm nút.
   *  - Còn bảng lương THÁNG SAU đã chốt thì không mở: mở ngược từ tháng mới
   *    nhất về, để không có hai tháng cùng "đang sửa" chồng lên nhau.
   *  - Bắt buộc lý do; nhật ký giữ ảnh chụp đủ các dòng đã chốt.
   */
  async reopen(dto: ReopenPayrollRequest): Promise<PayrollResponse> {
    const ctx = requireContext();

    await this.tdb.run(async (tx) => {
      // Cùng khoá với close(): không ai chốt lại trong lúc đang mở.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':payroll:' || ${dto.month}))`.execute(tx);

      const run = await tx
        .selectFrom('payroll_run')
        .select(['id', 'status', 'closed_at', 'closed_by'])
        .where('period_month', '=', dauThang(dto.month))
        .forUpdate()
        .executeTakeFirst();
      if (!run) throw new NotFoundException('PAYROLL_NOT_FOUND');
      if (run.status === 'PAID') {
        throw new ConflictException({
          code: 'PAYROLL_ALREADY_PAID',
          message: 'Bảng lương này đã chi — không mở lại được. Sai sót thì điều chỉnh ở bảng lương tháng sau.',
        });
      }
      if (run.status !== 'CLOSED') {
        throw new BadRequestException({ code: 'PAYROLL_NOT_CLOSED', message: 'Bảng lương tháng này chưa chốt.' });
      }
      const sauDo = await tx
        .selectFrom('payroll_run')
        .select('period_month')
        .where('period_month', '>', dauThang(dto.month))
        .orderBy('period_month')
        .executeTakeFirst();
      if (sauDo) {
        throw new ConflictException({
          code: 'PAYROLL_LATER_CLOSED',
          message: `Bảng lương tháng ${String(sauDo.period_month).slice(0, 7)} đã chốt sau tháng này — mở lại tháng đó trước.`,
        });
      }

      const dong = await tx
        .selectFrom('payroll_line')
        .select(['trainer_id', 'base_salary', 'commission_sale', 'commission_teach', 'adjustment', 'adjustment_note', 'total', 'sessions_taught'])
        .where('run_id', '=', run.id)
        .execute();
      const soHoaHong = await tx
        .selectFrom('commission_entry')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('payroll_line_id', 'in', tx.selectFrom('payroll_line').select('id').where('run_id', '=', run.id))
        .executeTakeFirstOrThrow();

      await tx.deleteFrom('payroll_run').where('id', '=', run.id).execute();

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'PAYROLL_REOPENED',
          entity: 'payroll_run',
          entity_id: run.id,
          before: JSON.stringify({ month: dto.month, closedAt: run.closed_at, closedBy: run.closed_by, lines: dong }),
          after: JSON.stringify({ reason: dto.reason, releasedCommissions: Number(soHoaHong.n) }),
        })
        .execute();
    });

    return this.view(dto.month);
  }

  /** Đánh dấu đã chi lương. Không đổi con số, chỉ đổi trạng thái. */
  async markPaid(thang: string): Promise<PayrollResponse> {
    const ctx = requireContext();

    await this.tdb.run(async (tx) => {
      const run = await tx
        .selectFrom('payroll_run')
        .select(['id', 'status'])
        .where('period_month', '=', dauThang(thang))
        .executeTakeFirst();
      if (!run) throw new NotFoundException('PAYROLL_NOT_FOUND');
      if (run.status === 'PAID') return;
      if (run.status !== 'CLOSED') {
        throw new BadRequestException({
          code: 'PAYROLL_NOT_CLOSED',
          message: 'Phải chốt bảng lương trước khi đánh dấu đã chi',
        });
      }

      await tx
        .updateTable('payroll_run')
        .set({ status: 'PAID', paid_at: new Date(), paid_by: ctx.identityId })
        .where('id', '=', run.id)
        .execute();

      await tx
        .updateTable('commission_entry')
        .set({ paid_out_at: new Date() })
        .where(
          'payroll_line_id',
          'in',
          tx.selectFrom('payroll_line').select('id').where('run_id', '=', run.id),
        )
        .execute();
    });

    return this.view(thang);
  }

  // -------------------------------------------------------------------------

  /** Bảng lương TẠM TÍNH cho tháng chưa chốt. */
  private async tinhTam(tx: Tx, thang: string) {
    const rows = await tx
      .selectFrom('trainer as t')
      .innerJoin('identity as i', 'i.id', 't.identity_id')
      .select((eb) => [
        't.id as trainerId', 't.code as trainerCode', 'i.full_name as trainerName',
        't.base_salary as baseSalary',
        eb
          .selectFrom('commission_entry as ce')
          .select((e) => e.fn.coalesce(e.fn.sum<string>('ce.amount'), e.val('0')).as('s'))
          .whereRef('ce.trainer_id', '=', 't.id')
          .where('ce.kind', '=', 'SALE')
          .where('ce.payroll_line_id', 'is', null)
          .where('ce.period_month', '<=', dauThang(thang))
          .as('ban'),
        eb
          .selectFrom('commission_entry as ce')
          .select((e) => e.fn.coalesce(e.fn.sum<string>('ce.amount'), e.val('0')).as('s'))
          .whereRef('ce.trainer_id', '=', 't.id')
          .where('ce.kind', '=', 'TEACH')
          .where('ce.payroll_line_id', 'is', null)
          .where('ce.period_month', '<=', dauThang(thang))
          .as('day'),
        eb
          .selectFrom('commission_entry as ce')
          .select((e) => e.fn.countAll<string>().as('c'))
          .whereRef('ce.trainer_id', '=', 't.id')
          .where('ce.kind', '=', 'TEACH')
          .where('ce.payroll_line_id', 'is', null)
          .where('ce.period_month', '<=', dauThang(thang))
          .as('soBuoi'),
      ])
      .where('t.status', '=', 'ACTIVE')
      .orderBy('t.code')
      .execute();

    // Hoa hồng của tháng TRƯỚC chưa trả — sẽ bị cuốn vào kỳ này. Nói ra để
    // người chốt lương không ngạc nhiên vì tổng lớn hơn số liệu của tháng.
    const cu = await sql<{ amount: string; n: string }>`
      SELECT COALESCE(SUM(amount), 0)::text AS amount, count(*)::text AS n
      FROM commission_entry
      WHERE payroll_line_id IS NULL AND period_month < ${dauThang(thang)}::date`.execute(tx);

    const lines: PayrollLine[] = rows.map((r) => {
      const ban = Number(r.ban ?? 0);
      const day = Number(r.day ?? 0);
      return {
        id: null,
        trainerId: r.trainerId,
        trainerCode: r.trainerCode,
        trainerName: r.trainerName,
        baseSalary: Number(r.baseSalary),
        commissionSale: ban,
        commissionTeach: day,
        adjustment: 0,
        adjustmentNote: null,
        total: Number(r.baseSalary) + ban + day,
        sessionsTaught: Number(r.soBuoi ?? 0),
      };
    });

    return {
      lines,
      carriedOver: {
        amount: Number(cu.rows[0]!.amount),
        entryCount: Number(cu.rows[0]!.n),
      },
    };
  }
}
