import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type { SellPackageRequest, SellPackageResponse } from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { CommissionService } from '../commission/commission.service';

@Injectable()
export class SaleService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly commission: CommissionService,
  ) {}

  /**
   * Bán một gói. MỘT giao dịch, năm thứ được ghi:
   *
   *   1. member_package  — hợp đồng, đã CHỤP ẢNH giá/số buổi/tên gói
   *   2. session_ledger  — +N buổi, lý do PURCHASE
   *   3. invoice + item  — số phải thu
   *   4. payment_schedule— kế hoạch trả góp (nếu có)
   *   5. payment         — tiền thu ngay (nếu có) + hoa hồng bán hàng
   *
   * Tách thành nhiều lời gọi API là mở đường cho trạng thái nửa vời: hợp đồng
   * có mà hoá đơn không, hoặc buổi tập được cộng mà không ai nợ tiền.
   */
  async sell(dto: SellPackageRequest): Promise<SellPackageResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      if (dto.idempotencyKey) {
        const daBan = await tx
          .selectFrom('payment')
          .select('invoice_id')
          .where('idempotency_key', '=', dto.idempotencyKey)
          .executeTakeFirst();
        if (daBan) {
          throw new BadRequestException({
            code: 'SALE_ALREADY_RECORDED',
            message: 'Giao dịch này đã được ghi nhận',
            details: { invoiceId: daBan.invoice_id },
          });
        }
      }

      const member = await tx
        .selectFrom('member')
        .select(['id', 'status'])
        .where('id', '=', dto.memberId)
        .executeTakeFirst();
      if (!member) throw new NotFoundException('MEMBER_NOT_FOUND');
      if (member.status === 'BANNED') {
        throw new BadRequestException({
          code: 'MEMBER_BANNED',
          message: 'Hội viên đang bị khoá, không bán gói mới được',
        });
      }

      const tpl = await tx
        .selectFrom('package_template')
        .selectAll()
        .where('id', '=', dto.templateId)
        .executeTakeFirst();
      if (!tpl) throw new NotFoundException('PACKAGE_TEMPLATE_NOT_FOUND');
      if (!tpl.is_active) {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Gói "${tpl.name}" đã ngừng bán`,
        });
      }

      const giaGoc = Number(tpl.price);
      if (dto.discount > giaGoc) {
        throw new BadRequestException({
          code: 'DISCOUNT_EXCEEDS_PRICE',
          message: 'Số tiền giảm lớn hơn giá gói',
        });
      }
      const phaiThu = giaGoc - dto.discount;

      const soldById = dto.soldById ?? dto.trainerId ?? null;
      if (soldById) {
        const pt = await tx
          .selectFrom('trainer')
          .select(['id', 'status'])
          .where('id', '=', soldById)
          .executeTakeFirst();
        if (!pt) throw new NotFoundException('TRAINER_NOT_FOUND');
        if (pt.status !== 'ACTIVE') {
          throw new BadRequestException({
            code: 'TRAINER_NOT_ACTIVE',
            message: 'Huấn luyện viên bán gói không còn làm việc',
          });
        }

        // Chặn NGAY tại đây nếu chưa khai chính sách hoa hồng. Phát hiện lúc bán
        // thì sửa cấu hình rồi bán lại là xong; phát hiện ở kỳ lương thì phải
        // truy lại hàng trăm lần thu.
        const policy = await this.commission.resolvePolicy(
          tx,
          soldById,
          tpl.id,
          dto.startsOn ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }),
        );
        if (!policy) {
          throw new BadRequestException({
            code: 'COMMISSION_POLICY_MISSING',
            message:
              'Chưa có chính sách hoa hồng áp dụng cho huấn luyện viên này. ' +
              'Khai chính sách mặc định của phòng tập trước khi bán gói.',
          });
        }
      }

      // Trả góp: tổng các đợt phải bằng số phải thu. Trigger DEFERRABLE ở CSDL
      // cũng gác, nhưng chặn ở đây cho ra thông báo người dùng đọc được.
      const traGop = dto.installments.length > 0;
      if (traGop) {
        const tongDot = dto.installments.reduce((s, x) => s + x.amount, 0);
        if (tongDot !== phaiThu) {
          throw new BadRequestException({
            code: 'INSTALLMENT_TOTAL_MISMATCH',
            message: `Tổng các đợt (${tongDot.toLocaleString('vi-VN')} ₫) phải bằng số phải thu (${phaiThu.toLocaleString('vi-VN')} ₫)`,
          });
        }
      }

      if (dto.initialPayment && dto.initialPayment.amount > phaiThu) {
        throw new BadRequestException({
          code: 'OVERPAYMENT',
          message: 'Số tiền thu lớn hơn số phải thu',
        });
      }

      // --- 1. hợp đồng ------------------------------------------------------
      const packageCode = await this.nextCode(tx, 'member_package', 'HD', 4);
      const batDau = dto.startsOn ?? sql<string>`current_date`;

      const mp = await tx
        .insertInto('member_package')
        .values({
          tenant_id: ctx.tenantId,
          member_id: dto.memberId,
          template_id: tpl.id,
          code: packageCode,
          // SNAPSHOT: đổi bảng giá tháng sau không được làm đổi hợp đồng này.
          name_snapshot: tpl.name,
          price_gross: giaGoc,
          discount: dto.discount,
          sessions_total: tpl.sessions,
          sold_by_id: soldById,
          trainer_id: dto.trainerId ?? null,
          starts_on: batDau as never,
          expires_on: sql`(${batDau}::date + ${tpl.valid_days}::int)` as never,
          created_by: ctx.identityId,
        })
        .returning(['id', 'code', 'expires_on', 'sessions_total'])
        .executeTakeFirstOrThrow();

      // --- 2. sổ cái buổi tập ----------------------------------------------
      await tx
        .insertInto('session_ledger')
        .values({
          tenant_id: ctx.tenantId,
          member_package_id: mp.id,
          delta: tpl.sessions,
          reason: 'PURCHASE',
          ref_type: 'MEMBER_PACKAGE',
          ref_id: mp.id,
          created_by: ctx.identityId,
        })
        .execute();

      // --- 3. hoá đơn -------------------------------------------------------
      const invoiceCode = await this.nextCode(tx, 'invoice', 'HD', 5);
      const inv = await tx
        .insertInto('invoice')
        .values({
          tenant_id: ctx.tenantId,
          member_id: dto.memberId,
          code: invoiceCode,
          total_amount: phaiThu,
          status: 'OPEN',
          is_installment: traGop,
          note: dto.note ?? null,
          created_by: ctx.identityId,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('invoice_item')
        .values({
          tenant_id: ctx.tenantId,
          invoice_id: inv.id,
          member_package_id: mp.id,
          description: dto.discount > 0 ? `${tpl.name} (đã giảm giá)` : tpl.name,
          quantity: 1,
          unit_price: phaiThu,
          amount: phaiThu,
        })
        .execute();

      // --- 4. kế hoạch trả góp ---------------------------------------------
      const schedule: SellPackageResponse['schedule'] = [];
      if (traGop) {
        const rows = await tx
          .insertInto('payment_schedule')
          .values(
            dto.installments.map((x, i) => ({
              tenant_id: ctx.tenantId,
              invoice_id: inv.id,
              seq: i + 1,
              due_date: x.dueDate,
              amount: x.amount,
            })),
          )
          .returning(['id', 'seq', 'due_date', 'amount', 'status'])
          .execute();
        schedule.push(
          ...rows.map((r) => ({
            id: r.id,
            seq: r.seq,
            dueDate: String(r.due_date),
            amount: Number(r.amount),
            status: r.status,
          })),
        );
      }

      // --- 5. thu ngay + hoa hồng ------------------------------------------
      let daThu = 0;
      if (dto.initialPayment) {
        const paidAt = new Date();
        const pay = await tx
          .insertInto('payment')
          .values({
            tenant_id: ctx.tenantId,
            invoice_id: inv.id,
            // Gắn vào đợt 1 nếu trả góp, để trigger đóng đúng đợt đó.
            schedule_id: schedule[0]?.id ?? null,
            amount: dto.initialPayment.amount,
            method: dto.initialPayment.method,
            reference: dto.initialPayment.reference ?? null,
            received_by: ctx.identityId,
            paid_at: paidAt,
            idempotency_key: dto.idempotencyKey ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        await this.commission.accrueForPayment(tx, {
          paymentId: pay.id,
          invoiceId: inv.id,
          signedAmount: dto.initialPayment.amount,
          paidAt,
        });
        daThu = dto.initialPayment.amount;
      }

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'PACKAGE_SOLD',
          entity: 'member_package',
          entity_id: mp.id,
          after: JSON.stringify({
            packageCode: mp.code,
            invoiceCode: inv.code,
            total: phaiThu,
            paid: daThu,
            soldById,
          }),
        })
        .execute();

      return {
        memberPackageId: mp.id,
        packageCode: mp.code,
        invoiceId: inv.id,
        invoiceCode: inv.code,
        totalAmount: phaiThu,
        paidAmount: daThu,
        sessionsTotal: mp.sessions_total,
        expiresOn: String(mp.expires_on),
        schedule,
      };
    });
  }

  /**
   * Mã kế tiếp theo phòng tập.
   *
   * Khoá theo (tenant, bảng) trong suốt giao dịch: hai người bán cùng lúc thì
   * người sau chờ, thay vì cả hai đọc ra cùng một số rồi một người vỡ ở UNIQUE.
   */
  private async nextCode(tx: Tx, bang: string, tienTo: string, doDai: number): Promise<string> {
    const ctx = requireContext();
    await sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':code:' || ${bang}))`.execute(tx);

    const r = await sql<{ n: string }>`
      SELECT coalesce(max(substring(code from ${'^' + tienTo + '-?([0-9]+)$'})::int), 0) + 1 AS n
      FROM ${sql.table(bang)}
      WHERE code ~ ${'^' + tienTo + '-?[0-9]+$'}`.execute(tx);

    const so = String(Number(r.rows[0]!.n)).padStart(doDai, '0');
    return bang === 'invoice' ? `${tienTo}-${so}` : `${tienTo}${so}`;
  }
}
