import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import type {
  CreatePlanRequest,
  PlanRequestInfo,
  PlanRequestStatus,
  SaasUsage,
  SubscriptionOverview,
  SubscriptionStatus,
  TenantStanding,
  TenantStatus,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { COT_HOA_DON_SAAS, goiSaas, hoaDonSaas } from '../common/saas-mappers';
import { SAAS_GRACE_DAYS, congNgay } from '../common/saas-policy';
import { hanMucTinThang } from '../notification/quota';

/**
 * Gói dịch vụ, nhìn từ PHÍA PHÒNG TẬP.
 *
 * Phòng tập không tự đổi được gì ở đây — app_rw chỉ có SELECT trên plan,
 * tenant_subscription, tenant_billing_record (0005), và không có UPDATE trên
 * cột status của tenant (0016). Đổi gói, gia hạn, mở khoá là việc của nền
 * tảng, qua /platform. Việc DUY NHẤT phòng tập ghi được là GỬI yêu cầu đổi gói
 * (0017) — nền tảng duyệt rồi mới đổi.
 */
@Injectable()
export class SubscriptionService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly cfg: ConfigService,
  ) {}

  standing(): Promise<TenantStanding> {
    return this.tdb.run((tx) => this.dung(tx));
  }

  overview(): Promise<SubscriptionOverview> {
    return this.tdb.run(async (tx) => {
      const st = await this.dung(tx);
      const sub = await tx
        .selectFrom('tenant_subscription')
        .select(['plan_code', 'trial_ends_at', 'current_period_start'])
        .executeTakeFirstOrThrow();
      const plans = await tx
        .selectFrom('plan')
        .select(['code', 'name', 'price_monthly', 'max_members', 'max_trainers', 'max_messages_month', 'is_public'])
        .where((eb) => eb.or([eb('is_public', '=', true), eb('code', '=', sub.plan_code)]))
        .orderBy('sort_order')
        .execute();
      const invoices = await tx
        .selectFrom('tenant_billing_record as b')
        .innerJoin('plan as pl', 'pl.code', 'b.plan_code')
        .select([...COT_HOA_DON_SAAS])
        // Hoá đơn đã huỷ là việc nội bộ của nền tảng (sai giá, phát hành lại) —
        // hiện ra chỉ làm chủ phòng hoang mang "tôi có phải trả hai lần không".
        .where('b.status', '<>', 'VOID')
        .orderBy('b.period_start', 'desc')
        .limit(12)
        .execute();

      const bank = {
        bankName: this.cfg.get<string>('SAAS_BANK_NAME') ?? '',
        accountNo: this.cfg.get<string>('SAAS_BANK_ACCOUNT') ?? '',
        accountName: this.cfg.get<string>('SAAS_BANK_HOLDER') ?? '',
      };

      return {
        ...st,
        planCode: sub.plan_code,
        trialEndsAt: sub.trial_ends_at ? new Date(sub.trial_ends_at).toISOString() : null,
        periodStart: sub.current_period_start,
        usage: await this.suDung(tx),
        invoices: invoices.map(hoaDonSaas),
        plans: plans.map(goiSaas),
        payTo: bank.bankName && bank.accountNo ? bank : null,
        graceDays: SAAS_GRACE_DAYS,
        supportContact: this.cfg.get<string>('SAAS_SUPPORT_CONTACT') || null,
        planRequest: await this.yeuCauGanNhat(tx),
      };
    });
  }

  /**
   * Chủ phòng xin đổi gói. KHÔNG đổi ngay và không tính chênh lệch: nền tảng
   * duyệt, hạn mức mới có hiệu lực lúc duyệt, giá mới áp từ hoá đơn kỳ sau.
   */
  requestPlanChange(req: CreatePlanRequest): Promise<PlanRequestInfo> {
    const ctx = requireContext();
    return this.tdb.run(async (tx) => {
      const sub = await tx.selectFrom('tenant_subscription').select('plan_code').executeTakeFirstOrThrow();
      const plan = await tx
        .selectFrom('plan')
        .select(['code', 'name', 'max_members', 'max_trainers'])
        .where('code', '=', req.planCode)
        .where('is_public', '=', true)
        .executeTakeFirst();
      if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND', message: 'Gói không tồn tại.' });
      if (plan.code === sub.plan_code) {
        throw new BadRequestException({ code: 'SAME_PLAN', message: 'Phòng đang dùng đúng gói này.' });
      }

      // Hạ gói khi đang vượt hạn mức gói đích: báo ngay, đừng để nó nằm trong
      // hàng chờ rồi bị từ chối sau hai ngày.
      const u = await this.suDung(tx);
      const vuot: string[] = [];
      if (plan.max_members !== null && u.members.used > plan.max_members) {
        vuot.push(`${u.members.used} hội viên (gói cho ${plan.max_members})`);
      }
      if (plan.max_trainers !== null && u.trainers.used > plan.max_trainers) {
        vuot.push(`${u.trainers.used} huấn luyện viên (gói cho ${plan.max_trainers})`);
      }
      if (vuot.length) {
        throw new BadRequestException({
          code: 'PLAN_TOO_SMALL',
          message: `Phòng đang có ${vuot.join(' và ')} — vượt hạn mức gói ${plan.name}. Giảm bớt trước khi xin hạ gói.`,
        });
      }

      try {
        await tx
          .insertInto('plan_change_request')
          .values({
            tenant_id: ctx.tenantId,
            from_plan: sub.plan_code,
            to_plan: plan.code,
            note: req.note || null,
            requested_by: ctx.identityId,
          })
          .execute();
      } catch (e) {
        if (String(e).includes('uq_pcr_pending')) {
          throw new ConflictException({
            code: 'PLAN_REQUEST_PENDING',
            message: 'Đã có một yêu cầu đổi gói đang chờ duyệt. Huỷ yêu cầu đó trước nếu muốn đổi sang gói khác.',
          });
        }
        throw e;
      }
      return (await this.yeuCauGanNhat(tx))!;
    });
  }

  cancelPlanRequest(): Promise<void> {
    const ctx = requireContext();
    return this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('plan_change_request')
        .set({ status: 'CANCELLED', decided_by: ctx.identityId, decided_at: new Date() })
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('NO_PENDING_PLAN_REQUEST');
    });
  }

  /** Yêu cầu đang chờ; không có thì yêu cầu vừa được xử lý trong 30 ngày (để báo kết quả). */
  private async yeuCauGanNhat(tx: Tx): Promise<PlanRequestInfo | null> {
    const r = await tx
      .selectFrom('plan_change_request as r')
      .innerJoin('plan as p', 'p.code', 'r.to_plan')
      .select([
        'r.id', 'r.from_plan', 'r.to_plan', 'p.name as to_name', 'r.note', 'r.status',
        'r.created_at', 'r.decided_at', 'r.decision_note',
      ])
      .where((eb) =>
        eb.or([
          eb('r.status', '=', 'PENDING'),
          eb.and([eb('r.status', '<>', 'CANCELLED'), eb('r.decided_at', '>', sql<Date>`now() - interval '30 days'`)]),
        ]),
      )
      .orderBy(sql`r.status = 'PENDING'`, 'desc')
      .orderBy('r.created_at', 'desc')
      .executeTakeFirst();
    if (!r) return null;
    return {
      id: r.id,
      fromPlan: r.from_plan,
      toPlan: r.to_plan,
      toPlanName: r.to_name,
      note: r.note,
      status: r.status as PlanRequestStatus,
      createdAt: new Date(r.created_at).toISOString(),
      decidedAt: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      decisionNote: r.decision_note,
    };
  }

  private async dung(tx: Tx): Promise<TenantStanding> {
    const t = await tx.selectFrom('tenant').select(['status', 'status_note']).executeTakeFirstOrThrow();
    const s = await tx
      .selectFrom('tenant_subscription as s')
      .innerJoin('plan as p', 'p.code', 's.plan_code')
      .select(['s.status', 's.current_period_end', 'p.name'])
      .executeTakeFirstOrThrow();
    const open = await tx
      .selectFrom('tenant_billing_record')
      .select(['id', 'amount', 'due_date', 'transfer_ref'])
      .where('status', '=', 'PENDING')
      .orderBy('period_start')
      .executeTakeFirst();

    return {
      tenantStatus: t.status as TenantStatus,
      statusNote: t.status_note,
      subscriptionStatus: s.status as SubscriptionStatus,
      planName: s.name,
      paidThrough: s.current_period_end,
      openInvoice: open
        ? { id: open.id, amount: Number(open.amount), dueDate: open.due_date, transferRef: open.transfer_ref }
        : null,
      // Khớp saas_lifecycle_tick: khoá khi current_period_end + grace < hôm nay.
      suspendOn:
        s.status === 'PAST_DUE' && t.status === 'PAST_DUE'
          ? congNgay(s.current_period_end, SAAS_GRACE_DAYS + 1)
          : null,
    };
  }

  /**
   * Đã dùng / hạn mức — đếm ĐÚNG như assert_quota (0007) đếm lúc chặn:
   * hội viên chưa bị cấm, huấn luyện viên đang làm. Đếm khác đi là màn này báo
   * "còn 3 chỗ" trong khi thêm hội viên bị từ chối.
   */
  private async suDung(tx: Tx): Promise<SaasUsage> {
    const p = await tx
      .selectFrom('tenant_subscription as s')
      .innerJoin('plan as p', 'p.code', 's.plan_code')
      .select(['p.max_members', 'p.max_trainers'])
      .executeTakeFirstOrThrow();
    const m = await tx
      .selectFrom('member')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', '<>', 'BANNED')
      .executeTakeFirst();
    const tr = await tx
      .selectFrom('trainer')
      .select(sql<number>`count(*)::int`.as('n'))
      .where('status', '=', 'ACTIVE')
      .executeTakeFirst();
    return {
      members: { used: Number(m?.n ?? 0), limit: p.max_members },
      trainers: { used: Number(tr?.n ?? 0), limit: p.max_trainers },
      messages: await hanMucTinThang(tx),
    };
  }
}
