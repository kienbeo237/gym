import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  InvoiceDetail,
  InvoiceStatus,
  InvoiceSummary,
  ListInvoiceQuery,
  Paged,
  PaymentResult,
  RecordPaymentRequest,
  RefundRequest,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { CommissionService } from '../commission/commission.service';

@Injectable()
export class BillingService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly commission: CommissionService,
  ) {}

  async list(q: ListInvoiceQuery): Promise<Paged<InvoiceSummary>> {
    return this.tdb.run(async (tx) => {
      const base = tx
        .selectFrom('invoice as inv')
        .innerJoin('member as m', 'm.id', 'inv.member_id')
        .innerJoin('identity as i', 'i.id', 'm.identity_id')
        .$if(!!q.memberId, (qb) => qb.where('inv.member_id', '=', q.memberId!))
        .$if(!!q.status, (qb) => qb.where('inv.status', '=', q.status!))
        .$if(q.unpaidOnly, (qb) => qb.where('inv.status', 'in', ['OPEN', 'PARTIALLY_PAID']))
        .$if(q.overdueOnly, (qb) =>
          qb.where((eb) =>
            eb.exists(
              eb
                .selectFrom('payment_schedule as ps')
                .select('ps.id')
                .whereRef('ps.invoice_id', '=', 'inv.id')
                .where('ps.status', 'in', ['DUE', 'OVERDUE'])
                .where('ps.due_date', '<', sql<Date>`current_date`),
            ),
          ),
        );

      const total = Number(
        (await base.select((eb) => eb.fn.countAll<string>().as('t')).executeTakeFirstOrThrow()).t,
      );

      const rows = await base
        .select((eb) => [
          'inv.id', 'inv.code', 'inv.member_id as memberId', 'inv.issued_at as issuedAt',
          'inv.total_amount as totalAmount', 'inv.paid_amount as paidAmount',
          'inv.status', 'inv.is_installment as isInstallment',
          'i.full_name as memberName', 'm.code as memberCode',
          eb
            .selectFrom('payment_schedule as ps')
            .select((e) => e.fn.countAll<string>().as('c'))
            .whereRef('ps.invoice_id', '=', 'inv.id')
            .where('ps.status', 'in', ['DUE', 'OVERDUE'])
            .where('ps.due_date', '<', sql<Date>`current_date`)
            .as('overdueCount'),
          eb
            .selectFrom('payment_schedule as ps')
            .select('ps.due_date')
            .whereRef('ps.invoice_id', '=', 'inv.id')
            .where('ps.status', 'in', ['DUE', 'OVERDUE'])
            .orderBy('ps.due_date', 'asc')
            .limit(1)
            .as('nextDueDate'),
        ])
        .orderBy('inv.issued_at', 'desc')
        .limit(q.size)
        .offset((q.page - 1) * q.size)
        .execute();

      return {
        items: rows.map((r) => ({
          id: r.id,
          code: r.code,
          memberId: r.memberId,
          memberName: r.memberName,
          memberCode: r.memberCode,
          issuedAt: new Date(r.issuedAt).toISOString(),
          totalAmount: Number(r.totalAmount),
          paidAmount: Number(r.paidAmount),
          outstanding: Number(r.totalAmount) - Number(r.paidAmount),
          status: r.status as InvoiceStatus,
          isInstallment: r.isInstallment,
          overdueCount: Number(r.overdueCount ?? 0),
          nextDueDate: r.nextDueDate ? String(r.nextDueDate) : null,
        })),
        page: q.page,
        size: q.size,
        total,
      };
    });
  }

  async detail(id: string): Promise<InvoiceDetail> {
    return this.tdb.run(async (tx) => {
      const inv = await tx
        .selectFrom('invoice as inv')
        .innerJoin('member as m', 'm.id', 'inv.member_id')
        .innerJoin('identity as i', 'i.id', 'm.identity_id')
        .select([
          'inv.id', 'inv.code', 'inv.member_id as memberId', 'inv.issued_at as issuedAt',
          'inv.total_amount as totalAmount', 'inv.paid_amount as paidAmount',
          'inv.status', 'inv.is_installment as isInstallment', 'inv.note',
          'i.full_name as memberName', 'm.code as memberCode',
        ])
        .where('inv.id', '=', id)
        .executeTakeFirst();
      if (!inv) throw new NotFoundException('INVOICE_NOT_FOUND');

      const [items, schedule, payments] = await Promise.all([
        tx
          .selectFrom('invoice_item as it')
          .leftJoin('member_package as mp', 'mp.id', 'it.member_package_id')
          .select([
            'it.id', 'it.description', 'it.quantity', 'it.unit_price as unitPrice',
            'it.amount', 'it.member_package_id as memberPackageId', 'mp.code as packageCode',
          ])
          .where('it.invoice_id', '=', id)
          .orderBy('it.id')
          .execute(),
        tx
          .selectFrom('payment_schedule as ps')
          .select((eb) => [
            'ps.id', 'ps.seq', 'ps.due_date as dueDate', 'ps.amount', 'ps.status',
            eb
              .selectFrom('payment as p')
              .select((e) => e.fn.coalesce(e.fn.sum<string>('p.signed_amount'), e.val('0')).as('s'))
              .whereRef('p.schedule_id', '=', 'ps.id')
              .as('paidAmount'),
          ])
          .where('ps.invoice_id', '=', id)
          .orderBy('ps.seq')
          .execute(),
        tx
          .selectFrom('payment as p')
          .leftJoin('identity as ri', 'ri.id', 'p.received_by')
          .select([
            'p.id', 'p.kind', 'p.amount', 'p.signed_amount as signedAmount', 'p.method',
            'p.paid_at as paidAt', 'p.reference', 'p.note', 'ri.full_name as receivedByName',
          ])
          .where('p.invoice_id', '=', id)
          .orderBy('p.paid_at')
          .execute(),
      ]);

      const overdue = schedule.filter(
        (s) => ['DUE', 'OVERDUE'].includes(s.status) && new Date(String(s.dueDate)) < new Date(),
      );

      return {
        id: inv.id,
        code: inv.code,
        memberId: inv.memberId,
        memberName: inv.memberName,
        memberCode: inv.memberCode,
        issuedAt: new Date(inv.issuedAt).toISOString(),
        totalAmount: Number(inv.totalAmount),
        paidAmount: Number(inv.paidAmount),
        outstanding: Number(inv.totalAmount) - Number(inv.paidAmount),
        status: inv.status as InvoiceStatus,
        isInstallment: inv.isInstallment,
        overdueCount: overdue.length,
        nextDueDate: schedule.find((s) => ['DUE', 'OVERDUE'].includes(s.status))?.dueDate
          ? String(schedule.find((s) => ['DUE', 'OVERDUE'].includes(s.status))!.dueDate)
          : null,
        note: inv.note,
        items: items.map((it) => ({
          id: it.id,
          description: it.description,
          quantity: it.quantity,
          unitPrice: Number(it.unitPrice),
          amount: Number(it.amount),
          memberPackageId: it.memberPackageId,
          packageCode: it.packageCode,
        })),
        schedule: schedule.map((s) => ({
          id: s.id,
          seq: s.seq,
          dueDate: String(s.dueDate),
          amount: Number(s.amount),
          paidAmount: Number(s.paidAmount ?? 0),
          status: s.status,
        })),
        payments: payments.map((p) => ({
          id: p.id,
          kind: p.kind as 'PAYMENT' | 'REFUND',
          amount: Number(p.amount),
          signedAmount: Number(p.signedAmount),
          method: p.method as InvoiceDetail['payments'][number]['method'],
          paidAt: new Date(p.paidAt).toISOString(),
          reference: p.reference,
          receivedByName: p.receivedByName,
          note: p.note,
        })),
      };
    });
  }

  async recordPayment(invoiceId: string, dto: RecordPaymentRequest): Promise<PaymentResult> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const inv = await this.locked(tx, invoiceId);

      if (inv.status === 'VOID') {
        throw new BadRequestException({
          code: 'INVOICE_VOID',
          message: 'Hoá đơn đã bị huỷ, không thu tiền được',
        });
      }

      const conLai = Number(inv.total_amount) - Number(inv.paid_amount);
      if (dto.amount > conLai && !dto.allowOverpay) {
        // Mặc định CHẶN: gõ thừa một số 0 là sai lệch gấp mười, và lỗi đó rất
        // khó phát hiện về sau. Ai thật sự muốn thu vượt thì bật cờ tường minh.
        throw new BadRequestException({
          code: 'OVERPAYMENT',
          message: `Số tiền thu (${dto.amount.toLocaleString('vi-VN')} ₫) lớn hơn số còn phải thu (${conLai.toLocaleString('vi-VN')} ₫)`,
          details: { outstanding: conLai },
        });
      }

      if (dto.scheduleId) {
        const ps = await tx
          .selectFrom('payment_schedule')
          .select(['id', 'status'])
          .where('id', '=', dto.scheduleId)
          .where('invoice_id', '=', invoiceId)
          .executeTakeFirst();
        if (!ps) throw new NotFoundException('SCHEDULE_NOT_FOUND');
      }

      const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
      const pay = await this.insertPayment(tx, {
        invoiceId,
        scheduleId: dto.scheduleId ?? null,
        kind: 'PAYMENT',
        amount: dto.amount,
        method: dto.method,
        reference: dto.reference ?? null,
        note: dto.note ?? null,
        paidAt,
        idempotencyKey: dto.idempotencyKey ?? null,
      });

      const commission = await this.commission.accrueForPayment(tx, {
        paymentId: pay.id,
        invoiceId,
        signedAmount: dto.amount,
        paidAt,
      });

      // Đọc LẠI sau khi trigger sync_invoice_paid đã chạy — không tự tính lại
      // ở đây, vì hai công thức song song là hai công thức sẽ lệch.
      const sau = await tx
        .selectFrom('invoice')
        .select(['status', 'paid_amount', 'total_amount'])
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow();

      await this.audit(tx, 'PAYMENT_RECORDED', invoiceId, {
        paymentId: pay.id,
        amount: dto.amount,
        method: dto.method,
      });

      return {
        paymentId: pay.id,
        invoiceStatus: sau.status as InvoiceStatus,
        paidAmount: Number(sau.paid_amount),
        outstanding: Number(sau.total_amount) - Number(sau.paid_amount),
        commission,
      };
    });
  }

  /**
   * Hoàn tiền = dòng payment RIÊNG mang dấu âm, không sửa dòng thu cũ.
   *
   * Lịch sử tiền phải cộng dồn được; viết đè lên dòng cũ là mất dấu vết ai thu
   * bao nhiêu vào lúc nào. Hoa hồng cũng sinh dòng ĐẢO chứ không sửa dòng cũ,
   * nhờ đó bảng lương tháng trước đã chốt vẫn đọc lại được y nguyên.
   */
  async refund(invoiceId: string, dto: RefundRequest): Promise<PaymentResult> {
    return this.tdb.run(async (tx) => {
      const inv = await this.locked(tx, invoiceId);

      const daThu = Number(inv.paid_amount);
      if (dto.amount > daThu) {
        throw new BadRequestException({
          code: 'REFUND_EXCEEDS_PAID',
          message: `Số tiền hoàn (${dto.amount.toLocaleString('vi-VN')} ₫) lớn hơn số đã thu (${daThu.toLocaleString('vi-VN')} ₫)`,
          details: { paidAmount: daThu },
        });
      }

      const paidAt = new Date();
      const pay = await this.insertPayment(tx, {
        invoiceId,
        scheduleId: null,
        kind: 'REFUND',
        amount: dto.amount,
        method: dto.method,
        reference: null,
        note: dto.reason,
        paidAt,
        idempotencyKey: dto.idempotencyKey ?? null,
      });

      const commission = await this.commission.accrueForPayment(tx, {
        paymentId: pay.id,
        invoiceId,
        signedAmount: -dto.amount,
        paidAt,
      });

      const sau = await tx
        .selectFrom('invoice')
        .select(['status', 'paid_amount', 'total_amount'])
        .where('id', '=', invoiceId)
        .executeTakeFirstOrThrow();

      await this.audit(tx, 'PAYMENT_REFUNDED', invoiceId, {
        paymentId: pay.id,
        amount: dto.amount,
        reason: dto.reason,
      });

      return {
        paymentId: pay.id,
        invoiceStatus: sau.status as InvoiceStatus,
        paidAmount: Number(sau.paid_amount),
        outstanding: Number(sau.total_amount) - Number(sau.paid_amount),
        commission,
      };
    });
  }

  /**
   * Huỷ hoá đơn lập nhầm. CHỈ khi chưa thu đồng nào — đã có tiền thì phải đi
   * đường hoàn tiền, để dòng tiền còn dấu vết.
   *
   * Huỷ hoá đơn kéo theo huỷ hợp đồng và ĐẢO số buổi đã cộng: bỏ bước đó thì
   * hội viên giữ nguyên N buổi mà không ai nợ tiền.
   */
  async voidInvoice(invoiceId: string, reason: string): Promise<{ cancelledPackages: number }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const inv = await this.locked(tx, invoiceId);
      if (inv.status === 'VOID') return { cancelledPackages: 0 };
      if (Number(inv.paid_amount) !== 0) {
        throw new BadRequestException({
          code: 'INVOICE_HAS_PAYMENTS',
          message: 'Hoá đơn đã phát sinh tiền. Dùng chức năng hoàn tiền thay vì huỷ.',
        });
      }

      const goi = await tx
        .selectFrom('invoice_item as ii')
        .innerJoin('member_package as mp', 'mp.id', 'ii.member_package_id')
        .select(['mp.id', 'mp.sessions_total', 'mp.sessions_used'])
        .where('ii.invoice_id', '=', invoiceId)
        .execute();

      for (const g of goi) {
        if (g.sessions_used > 0) {
          throw new BadRequestException({
            code: 'PACKAGE_ALREADY_USED',
            message: 'Hợp đồng đã có buổi tập được dùng, không huỷ hoá đơn được',
          });
        }
        await tx
          .insertInto('session_ledger')
          .values({
            tenant_id: ctx.tenantId,
            member_package_id: g.id,
            delta: -g.sessions_total,
            reason: 'REFUND',
            ref_type: 'INVOICE',
            ref_id: invoiceId,
            note: reason,
            created_by: ctx.identityId,
          })
          .execute();
        await tx
          .updateTable('member_package')
          .set({ status: 'CANCELLED' })
          .where('id', '=', g.id)
          .execute();
      }

      await tx
        .updateTable('invoice')
        .set({ status: 'VOID', voided_at: new Date(), voided_by: ctx.identityId })
        .where('id', '=', invoiceId)
        .execute();

      await this.audit(tx, 'INVOICE_VOIDED', invoiceId, { reason, packages: goi.length });
      return { cancelledPackages: goi.length };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Khoá hàng hoá đơn tới hết giao dịch.
   *
   * Không có nó thì hai người thu cùng lúc đều đọc `paid_amount` cũ, đều thấy
   * "còn nợ", và cả hai cùng ghi — thu vượt mà không cờ nào chặn.
   */
  private async locked(tx: Tx, invoiceId: string) {
    const r = await sql<{
      id: string; status: string; paid_amount: string; total_amount: string;
    }>`SELECT id, status, paid_amount, total_amount FROM invoice
       WHERE id = ${invoiceId}::uuid FOR UPDATE`.execute(tx);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('INVOICE_NOT_FOUND');
    return row;
  }

  private async insertPayment(
    tx: Tx,
    p: {
      invoiceId: string;
      scheduleId: string | null;
      kind: 'PAYMENT' | 'REFUND';
      amount: number;
      method: string;
      reference: string | null;
      note: string | null;
      paidAt: Date;
      idempotencyKey: string | null;
    },
  ): Promise<{ id: string }> {
    const ctx = requireContext();
    try {
      return await tx
        .insertInto('payment')
        .values({
          tenant_id: ctx.tenantId,
          invoice_id: p.invoiceId,
          schedule_id: p.scheduleId,
          kind: p.kind,
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          note: p.note,
          paid_at: p.paidAt,
          received_by: ctx.identityId,
          idempotency_key: p.idempotencyKey,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (msg.includes('uq_payment_idem')) {
        throw new BadRequestException({
          code: 'PAYMENT_ALREADY_RECORDED',
          message: 'Lần thu này đã được ghi nhận',
        });
      }
      if (msg.includes('invoice_paid_nonneg')) {
        throw new BadRequestException({
          code: 'REFUND_EXCEEDS_PAID',
          message: 'Số tiền hoàn lớn hơn số đã thu',
        });
      }
      throw e;
    }
  }

  private async audit(
    tx: Tx,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    const ctx = requireContext();
    await tx
      .insertInto('audit_log')
      .values({
        tenant_id: ctx.tenantId,
        actor_id: ctx.identityId,
        action,
        entity: 'invoice',
        entity_id: entityId,
        after: JSON.stringify(after),
      })
      .execute();
  }
}
