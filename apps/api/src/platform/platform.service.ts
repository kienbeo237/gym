import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import type {
  AddPlatformAdminRequest,
  AddPlatformAdminResult,
  BankTxnOutcome,
  BankTxnRow,
  ChangePlanRequest,
  PlanRequestStatus,
  PlatformAdminRow,
  PlatformLevel,
  PlatformPlanRequestRow,
  ConfirmPaymentRequest,
  CreateTenantRequest,
  CreateTenantResult,
  ExtendTrialRequest,
  IssueInvoiceRequest,
  Paged,
  PlanInfo,
  PlatformAuditRow,
  PlatformInvoiceRow,
  PlatformOverview,
  PlatformTenantDetail,
  PlatformTenantRow,
  SaasUsage,
  SubscriptionStatus,
  TenantStatus,
} from '@pt/contracts';
import { COT_HOA_DON_SAAS, goiSaas, hoaDonSaas } from '../common/saas-mappers';
import { PlatformDb, type PlatformActor, type PTx } from './platform-db.service';

const THANG_VN = sql<string>`date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;
const HOM_NAY_VN = sql<string>`(now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`;

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

/** Lỗi SQL -> lỗi HTTP đọc được. Hàm saas_* (0016) ném mã ở đầu thông điệp. */
function dichLoi(e: unknown): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith('INVOICE_NOT_PENDING')) {
    throw new ConflictException({ code: 'INVOICE_NOT_PENDING', message: 'Hoá đơn này đã được xử lý rồi (có thể ở tab khác).' });
  }
  if (msg.startsWith('INVOICE_NOT_FOUND')) throw new NotFoundException('INVOICE_NOT_FOUND');
  if (msg.startsWith('NO_SUBSCRIPTION')) {
    throw new ConflictException({ code: 'NO_SUBSCRIPTION', message: 'Phòng tập chưa có thuê bao, hoặc thuê bao đã huỷ.' });
  }
  throw e;
}

/**
 * Quản trị nền tảng: xem mọi phòng tập, đổi gói, khoá / mở, và ĐỐI SOÁT THU TIỀN.
 *
 * Mọi hàm đi qua PlatformDb.run(), tức đều ghi nhật ký. Chuyển trạng thái
 * thuê bao (gia hạn, mở khoá sau khi trả) KHÔNG viết ở đây — gọi hàm SQL
 * saas_settle_invoice / saas_issue_invoice (0016), cùng hàm mà job hằng giờ
 * dùng. Ở đây chỉ còn: kiểm đầu vào, và những thao tác tay không có trong vòng
 * đời tự động (khoá tay, đóng phòng, gia hạn dùng thử).
 */
@Injectable()
export class PlatformService {
  constructor(private readonly pdb: PlatformDb) {}

  // ---- Đọc ---------------------------------------------------------------------

  overview(actor: PlatformActor): Promise<PlatformOverview> {
    return this.pdb.run(actor, 'SUPPORT', { action: 'platform.overview' }, async (tx) => {
      const byStatus = await tx
        .selectFrom('tenant')
        .select(['status', sql<number>`count(*)::int`.as('n')])
        .groupBy('status')
        .execute();
      const mrr = await tx
        .selectFrom('tenant_subscription as s')
        .innerJoin('plan as p', 'p.code', 's.plan_code')
        .innerJoin('tenant as t', 't.id', 's.tenant_id')
        .select(sql<string>`coalesce(sum(p.price_monthly), 0)`.as('v'))
        .where('s.status', 'in', ['ACTIVE', 'PAST_DUE'])
        .where('t.status', '<>', 'CLOSED')
        .executeTakeFirst();
      const open = await tx
        .selectFrom('tenant_billing_record')
        .select([
          sql<number>`count(*)::int`.as('n'),
          sql<string>`coalesce(sum(amount), 0)`.as('v'),
          sql<number>`count(*) FILTER (WHERE due_date < ${HOM_NAY_VN})::int`.as('qua_han'),
        ])
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      const paid = await tx
        .selectFrom('tenant_billing_record')
        .select(sql<string>`coalesce(sum(paid_amount), 0)`.as('v'))
        .where('status', '=', 'PAID')
        .where(sql<boolean>`(confirmed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= ${THANG_VN}`)
        .executeTakeFirst();
      const msg = await tx
        .selectFrom('tenant_message_usage')
        .select(sql<number>`coalesce(sum(sent_count), 0)::int`.as('n'))
        .where('channel', '=', 'ZALO_ZNS')
        .where('period_month', '=', THANG_VN)
        .executeTakeFirst();
      const yc = await tx
        .selectFrom('plan_change_request')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('status', '=', 'PENDING')
        .executeTakeFirst();
      const gd = await tx
        .selectFrom('bank_txn_event')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('outcome', 'not in', ['MATCHED', 'IGNORED'])
        .where('resolved_at', 'is', null)
        .executeTakeFirst();
      const ds = await tx
        .selectFrom('reconciliation_run')
        .select(['ran_at', 'total', 'counts', 'samples', 'errors'])
        .orderBy('ran_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

      return {
        reconciliation: ds
          ? {
              ranAt: iso(ds.ran_at),
              total: ds.total,
              counts: json(ds.counts),
              samples: json(ds.samples),
              errors: json(ds.errors),
            }
          : null,
        tenantsByStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        mrr: Number(mrr?.v ?? 0),
        openInvoices: { count: Number(open?.n ?? 0), amount: Number(open?.v ?? 0), overdue: Number(open?.qua_han ?? 0) },
        paidThisMonth: Number(paid?.v ?? 0),
        messagesThisMonth: Number(msg?.n ?? 0),
        pendingPlanRequests: Number(yc?.n ?? 0),
        unmatchedBankTxns: Number(gd?.n ?? 0),
      };
    });
  }

  tenants(actor: PlatformActor, f: { q?: string; status?: string }): Promise<PlatformTenantRow[]> {
    return this.pdb.run(
      actor,
      'SUPPORT',
      (rows: PlatformTenantRow[]) => ({ action: 'tenant.list', detail: { q: f.q ?? null, status: f.status ?? null, count: rows.length } }),
      (tx) => this.dsPhong(tx, f),
    );
  }

  tenant(actor: PlatformActor, id: string): Promise<PlatformTenantDetail> {
    return this.pdb.run(actor, 'SUPPORT', { action: 'tenant.view', tenantId: id }, async (tx) => {
      const [row] = await this.dsPhong(tx, { id });
      if (!row) throw new NotFoundException('TENANT_NOT_FOUND');
      const extra = await tx
        .selectFrom('tenant as t')
        .innerJoin('tenant_subscription as s', 's.tenant_id', 't.id')
        .select(['t.timezone', 't.suspend_kind', 's.trial_ends_at', 's.current_period_start'])
        .where('t.id', '=', id)
        .executeTakeFirstOrThrow();
      const owners = await tx
        .selectFrom('tenant_user as tu')
        .innerJoin('identity as i', 'i.id', 'tu.identity_id')
        .select(['i.full_name', 'i.phone'])
        .where('tu.tenant_id', '=', id)
        .where('tu.role', '=', 'OWNER')
        .where('tu.status', '=', 'ACTIVE')
        .execute();
      const invoices = await tx
        .selectFrom('tenant_billing_record as b')
        .innerJoin('plan as pl', 'pl.code', 'b.plan_code')
        .select([...COT_HOA_DON_SAAS])
        .where('b.tenant_id', '=', id)
        .orderBy('b.period_start', 'desc')
        .orderBy('b.created_at', 'desc')
        .limit(24)
        .execute();
      const audit = await this.nhatKy(tx, { tenantId: id, size: 30, offset: 0 });

      return {
        ...row,
        timezone: extra.timezone,
        suspendKind: (extra.suspend_kind as 'BILLING' | 'MANUAL' | null) ?? null,
        trialEndsAt: extra.trial_ends_at ? iso(extra.trial_ends_at) : null,
        periodStart: extra.current_period_start,
        owners: owners.map((o) => ({ fullName: o.full_name, phone: o.phone })),
        invoices: invoices.map(hoaDonSaas),
        audit: audit.items,
      };
    });
  }

  plans(actor: PlatformActor): Promise<PlanInfo[]> {
    return this.pdb.run(actor, 'SUPPORT', { action: 'plan.list' }, async (tx) => {
      const rows = await tx
        .selectFrom('plan')
        .select(['code', 'name', 'price_monthly', 'max_members', 'max_trainers', 'max_messages_month', 'is_public'])
        .orderBy('sort_order')
        .execute();
      return rows.map(goiSaas);
    });
  }

  invoices(actor: PlatformActor, f: { status?: string; q?: string }): Promise<PlatformInvoiceRow[]> {
    return this.pdb.run(
      actor,
      'SUPPORT',
      (rows: PlatformInvoiceRow[]) => ({ action: 'invoice.list', detail: { status: f.status ?? null, q: f.q ?? null, count: rows.length } }),
      async (tx) => {
        let q = tx
          .selectFrom('tenant_billing_record as b')
          .innerJoin('plan as pl', 'pl.code', 'b.plan_code')
          .innerJoin('tenant as t', 't.id', 'b.tenant_id')
          .leftJoin('identity as ci', 'ci.id', 'b.confirmed_by')
          .select([
            ...COT_HOA_DON_SAAS,
            'b.bank_txn_ref',
            't.id as tenant_id',
            't.name as tenant_name',
            't.slug as tenant_slug',
            't.status as tenant_status',
            'ci.full_name as confirmed_by_name',
          ]);
        if (f.status) q = q.where('b.status', '=', f.status);
        if (f.q?.trim()) {
          // Nội dung chuyển khoản trên sao kê hay bị ngân hàng gộp / tách khoảng
          // trắng: so sánh sau khi bỏ hết khoảng trắng.
          const k = `%${f.q.trim().replace(/\s+/g, '').toUpperCase()}%`;
          const k2 = `%${f.q.trim()}%`;
          q = q.where((eb) =>
            eb.or([
              eb(sql`upper(replace(b.transfer_ref, ' ', ''))`, 'like', k),
              eb('b.bank_txn_ref', 'ilike', k2),
              eb('t.name', 'ilike', k2),
              eb(sql`t.slug::text`, 'ilike', k2),
            ]),
          );
        }
        const rows = await q
          .orderBy(sql`CASE WHEN b.status = 'PENDING' THEN 0 ELSE 1 END`)
          .orderBy(sql`CASE WHEN b.status = 'PENDING' THEN b.due_date END`, 'asc')
          .orderBy('b.created_at', 'desc')
          .limit(200)
          .execute();
        return rows.map((r) => ({
          ...hoaDonSaas(r),
          tenantId: r.tenant_id,
          tenantName: r.tenant_name,
          tenantSlug: String(r.tenant_slug),
          tenantStatus: r.tenant_status as TenantStatus,
          bankTxnRef: r.bank_txn_ref,
          confirmedByName: r.confirmed_by_name,
        }));
      },
    );
  }

  audit(actor: PlatformActor, f: { tenantId?: string; page: number; size: number }): Promise<Paged<PlatformAuditRow>> {
    return this.pdb.run(
      actor,
      'SUPPORT',
      { action: 'audit.list', tenantId: f.tenantId ?? null, detail: { page: f.page } },
      async (tx) => {
        const r = await this.nhatKy(tx, { tenantId: f.tenantId, size: f.size, offset: (f.page - 1) * f.size });
        return { items: r.items, total: r.total, page: f.page, size: f.size };
      },
    );
  }

  // ---- Phòng tập ---------------------------------------------------------------

  /**
   * Mở phòng tập mới cho khách: phòng + thuê bao + chủ phòng, trong MỘT
   * transaction. Số điện thoại đã có tài khoản (người đó đang là hội viên / PT
   * ở phòng khác) thì dùng lại định danh đó — một người, một tài khoản.
   */
  createTenant(actor: PlatformActor, req: CreateTenantRequest): Promise<CreateTenantResult> {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: CreateTenantResult) => ({
        action: 'tenant.create',
        tenantId: kq.tenantId,
        detail: { slug: req.slug, planCode: req.planCode, trialDays: req.trialDays, ownerIsNew: kq.ownerIsNew },
      }),
      async (tx) => {
        const plan = await tx.selectFrom('plan').select('code').where('code', '=', req.planCode).executeTakeFirst();
        if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND', message: 'Gói không tồn tại.' });

        const trung = await tx.selectFrom('tenant').select('id').where('slug', '=', req.slug).executeTakeFirst();
        if (trung) throw new ConflictException({ code: 'SLUG_TAKEN', message: `Tên miền "${req.slug}" đã có phòng dùng.` });

        const dungThu = req.trialDays > 0;
        let tenantId: string;
        try {
          const t = await tx
            .insertInto('tenant')
            .values({ slug: req.slug, name: req.name, status: dungThu ? 'TRIAL' : 'ACTIVE' })
            .returning('id')
            .executeTakeFirstOrThrow();
          tenantId = t.id;
        } catch (e) {
          if (String(e).includes('tenant_slug_reserved')) {
            throw new BadRequestException({ code: 'SLUG_RESERVED', message: `"${req.slug}" là tên dành riêng của hệ thống.` });
          }
          throw e;
        }
        await tx.insertInto('tenant_policy').values({ tenant_id: tenantId }).execute();

        // "Đã trả tới" = hết ngày dùng thử cuối cùng. Không dùng thử thì đã trả
        // tới HÔM QUA: hoá đơn kỳ đầu phát hành ngay bên dưới, và 7 ngày ân hạn
        // bắt đầu tính từ hôm nay.
        await tx
          .insertInto('tenant_subscription')
          .values({
            tenant_id: tenantId,
            plan_code: req.planCode,
            status: dungThu ? 'TRIALING' : 'ACTIVE',
            trial_ends_at: dungThu ? sql<Date>`(${HOM_NAY_VN} + ${req.trialDays}::int)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'` : null,
            current_period_start: HOM_NAY_VN,
            current_period_end: sql<string>`${HOM_NAY_VN} + ${req.trialDays - 1}::int`,
          })
          .execute();

        let identity = await tx
          .selectFrom('identity')
          .select(['id', 'password_hash'])
          .where('phone', '=', req.ownerPhone)
          .executeTakeFirst();
        let tempPassword: string | null = null;
        const ownerIsNew = !identity;
        if (!identity || !identity.password_hash) {
          // Mật khẩu tạm hiện MỘT lần cho người vận hành đọc cho chủ phòng.
          tempPassword = randomBytes(9).toString('base64url');
          const hash = await bcrypt.hash(tempPassword, 10);
          if (identity) {
            await tx
              .updateTable('identity')
              .set({ password_hash: hash, must_change_password: true })
              .where('id', '=', identity.id)
              .execute();
          } else {
            identity = await tx
              .insertInto('identity')
              .values({ phone: req.ownerPhone, full_name: req.ownerName, password_hash: hash, must_change_password: true })
              .returning(['id', 'password_hash'])
              .executeTakeFirstOrThrow();
          }
        }
        await tx.insertInto('tenant_user').values({ tenant_id: tenantId, identity_id: identity.id, role: 'OWNER' }).execute();

        if (!dungThu) {
          await sql`SELECT saas_issue_invoice(${tenantId}::uuid, ${actor.identityId}::uuid, NULL, NULL)`.execute(tx);
        }
        return { tenantId, ownerIsNew, tempPassword };
      },
    );
  }

  changePlan(actor: PlatformActor, id: string, req: ChangePlanRequest) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { from: string }) => ({ action: 'subscription.change_plan', tenantId: id, detail: { from: kq.from, to: req.planCode, note: req.note ?? null } }),
      async (tx) => {
        const from = await this.doiGoi(tx, id, req.planCode);
        // Đổi tay khi phòng đang có yêu cầu chờ: yêu cầu đó coi như đã được
        // trả lời (khớp gói thì duyệt, lệch gói thì từ chối) — không để nó treo.
        await tx
          .updateTable('plan_change_request')
          .set((eb) => ({
            status: eb.case().when('to_plan', '=', req.planCode).then('APPROVED').else('REJECTED').end(),
            decided_by: actor.identityId,
            decided_at: new Date(),
            decision_note: 'Quản trị viên đổi gói trực tiếp',
          }))
          .where('tenant_id', '=', id)
          .where('status', '=', 'PENDING')
          .execute();
        return { from };
      },
    );
  }

  extendTrial(actor: PlatformActor, id: string, req: ExtendTrialRequest) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { voided: number }) => ({ action: 'subscription.extend_trial', tenantId: id, detail: { days: req.days, voidedInvoices: kq.voided, note: req.note ?? null } }),
      async (tx) => {
        const sub = await this.khoaThueBao(tx, id);
        const t = await tx.selectFrom('tenant').select('status').where('id', '=', id).executeTakeFirstOrThrow();
        // Đang dùng thử, hoặc vừa hết dùng thử mà chưa trả đồng nào.
        const chuaTraLanNao = !(await tx
          .selectFrom('tenant_billing_record')
          .select('id')
          .where('tenant_id', '=', id)
          .where('status', '=', 'PAID')
          .executeTakeFirst());
        if (!(sub.status === 'TRIALING' || (sub.status === 'PAST_DUE' && chuaTraLanNao))) {
          throw new BadRequestException({ code: 'NOT_IN_TRIAL', message: 'Chỉ gia hạn được khi phòng đang (hoặc vừa hết) dùng thử.' });
        }
        await tx
          .updateTable('tenant_subscription')
          .set({
            status: 'TRIALING',
            current_period_end: sql<string>`greatest(current_period_end, ${HOM_NAY_VN} - 1) + ${req.days}::int`,
            trial_ends_at: sql<Date>`(greatest(current_period_end, ${HOM_NAY_VN} - 1) + ${req.days}::int + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
          })
          .where('tenant_id', '=', id)
          .execute();
        // Hoá đơn kỳ đầu đã phát hành theo ngày hết dùng thử CŨ: giờ nó rơi vào
        // giữa kỳ dùng thử. Huỷ để job phát hành lại đúng ngày.
        const v = await tx
          .updateTable('tenant_billing_record')
          .set({ status: 'VOID', note: 'Huỷ tự động: gia hạn dùng thử' })
          .where('tenant_id', '=', id)
          .where('status', '=', 'PENDING')
          .executeTakeFirst();
        if (t.status === 'PAST_DUE' || (t.status === 'SUSPENDED' && (await this.khoaVi(tx, id)) === 'BILLING')) {
          await tx.updateTable('tenant').set({ status: 'TRIAL', suspend_kind: null, status_note: null }).where('id', '=', id).execute();
        }
        return { voided: Number(v.numUpdatedRows) };
      },
    );
  }

  suspend(actor: PlatformActor, id: string, note: string) {
    return this.pdb.run(actor, 'OPS', { action: 'tenant.suspend', tenantId: id, detail: { kind: 'MANUAL', note } }, async (tx) => {
      const t = await this.khoaPhong(tx, id);
      if (t.status === 'CLOSED') throw new BadRequestException({ code: 'TENANT_CLOSED', message: 'Phòng đã đóng.' });
      await tx
        .updateTable('tenant')
        .set({ status: 'SUSPENDED', suspend_kind: 'MANUAL', status_note: note })
        .where('id', '=', id)
        .execute();
      return { ok: true };
    });
  }

  /**
   * Mở khoá: trạng thái phòng lấy lại từ THUÊ BAO, không đặt thẳng ACTIVE. Mở
   * khoá tay một phòng đang nợ thì nó về PAST_DUE, và job sẽ khoá lại nếu vẫn
   * quá hạn — mở khoá không phải là xoá nợ. Xoá nợ là "Miễn" hoá đơn.
   */
  reactivate(actor: PlatformActor, id: string, note: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { status: string }) => ({ action: 'tenant.reactivate', tenantId: id, detail: { to: kq.status, note } }),
      async (tx) => {
        const t = await this.khoaPhong(tx, id);
        if (t.status !== 'SUSPENDED') throw new BadRequestException({ code: 'NOT_SUSPENDED', message: 'Phòng không bị khoá.' });
        const sub = await this.khoaThueBao(tx, id);
        const status = ({ TRIALING: 'TRIAL', ACTIVE: 'ACTIVE', PAST_DUE: 'PAST_DUE' } as Record<string, string>)[sub.status];
        if (!status) throw new BadRequestException({ code: 'SUBSCRIPTION_CANCELLED', message: 'Thuê bao đã huỷ — phòng đã đóng.' });
        await tx.updateTable('tenant').set({ status, suspend_kind: null, status_note: null }).where('id', '=', id).execute();
        return { status };
      },
    );
  }

  /** Đóng phòng: không đăng nhập được nữa. Dữ liệu GIỮ NGUYÊN — xoá là việc khác, có quy trình riêng. */
  close(actor: PlatformActor, id: string, note: string) {
    return this.pdb.run(actor, 'SUPER', { action: 'tenant.close', tenantId: id, detail: { note } }, async (tx) => {
      await this.khoaPhong(tx, id);
      await tx.updateTable('tenant').set({ status: 'CLOSED', suspend_kind: null, status_note: note }).where('id', '=', id).execute();
      await tx.updateTable('tenant_subscription').set({ status: 'CANCELLED' }).where('tenant_id', '=', id).execute();
      await tx
        .updateTable('tenant_billing_record')
        .set({ status: 'VOID', note: 'Huỷ tự động: đóng phòng' })
        .where('tenant_id', '=', id)
        .where('status', '=', 'PENDING')
        .execute();
      return { ok: true };
    });
  }

  // ---- Hoá đơn & đối soát -----------------------------------------------------

  issueInvoice(actor: PlatformActor, tenantId: string, req: IssueInvoiceRequest) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { id: string }) => ({ action: 'invoice.issue', tenantId, detail: { invoiceId: kq.id, amount: req.amount ?? null, note: req.note ?? null } }),
      async (tx) => {
        const gia = await tx
          .selectFrom('tenant_subscription as s')
          .innerJoin('plan as p', 'p.code', 's.plan_code')
          .select('p.price_monthly')
          .where('s.tenant_id', '=', tenantId)
          .executeTakeFirst();
        if (!gia) throw new NotFoundException('TENANT_NOT_FOUND');
        if (req.amount !== undefined && req.amount !== Number(gia.price_monthly) && !req.note) {
          throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'Số tiền khác giá gói — ghi chú lý do (giảm giá, bù trừ...).' });
        }
        const r = await sql<{ id: string | null }>`
          SELECT saas_issue_invoice(${tenantId}::uuid, ${actor.identityId}::uuid, ${req.amount ?? null}::bigint, ${req.note ?? null}::text) AS id
        `.execute(tx).catch(dichLoi);
        const id = r.rows[0]?.id;
        if (!id) {
          throw new ConflictException({ code: 'INVOICE_EXISTS', message: 'Kỳ kế tiếp đã có hoá đơn. Huỷ hoá đơn đó trước nếu muốn phát hành lại.' });
        }
        return { id };
      },
    );
  }

  /**
   * Xác nhận ĐÃ NHẬN TIỀN — sau khi đối chiếu sao kê. Nhận thiếu thì không xác
   * nhận được: hoặc huỷ hoá đơn và phát hành lại đúng số đã thoả thuận, hoặc
   * chờ khoản còn lại. "PAID" mà thiếu tiền là con số doanh thu sai.
   */
  confirm(actor: PlatformActor, invoiceId: string, req: ConfirmPaymentRequest) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string; amount: number; transferRef: string }) => ({
        action: 'invoice.confirm',
        tenantId: kq.tenantId,
        detail: { invoiceId, amount: kq.amount, paidAmount: req.paidAmount, bankTxnRef: req.bankTxnRef, transferRef: kq.transferRef },
      }),
      async (tx) => {
        const b = await this.hoaDon(tx, invoiceId);
        const amount = Number(b.amount);
        if (req.paidAmount < amount) {
          throw new BadRequestException({
            code: 'AMOUNT_SHORT',
            message: `Số nhận (${req.paidAmount.toLocaleString('vi-VN')}đ) ít hơn số phải thu (${amount.toLocaleString('vi-VN')}đ). Huỷ và phát hành lại hoá đơn đúng số đã thoả thuận, hoặc chờ khoản còn lại.`,
          });
        }
        if (req.paidAmount > amount && !req.note) {
          throw new BadRequestException({ code: 'NOTE_REQUIRED', message: 'Nhận dư so với hoá đơn — ghi chú cách xử lý phần dư.' });
        }
        // Cùng một giao dịch ngân hàng không được dùng để tất toán hai hoá đơn.
        const daDung = await tx
          .selectFrom('tenant_billing_record')
          .select('transfer_ref')
          .where('bank_txn_ref', '=', req.bankTxnRef)
          .where('status', '=', 'PAID')
          .executeTakeFirst();
        if (daDung) {
          throw new ConflictException({
            code: 'BANK_TXN_USED',
            message: `Mã giao dịch này đã dùng để xác nhận hoá đơn ${daDung.transfer_ref}.`,
          });
        }
        await sql`SELECT saas_settle_invoice(${invoiceId}::uuid, 'PAID', ${actor.identityId}::uuid,
                    ${req.bankTxnRef}::text, ${req.paidAmount}::bigint, ${req.note ?? null}::text)`
          .execute(tx)
          .catch(dichLoi);
        return { tenantId: b.tenant_id, amount, transferRef: b.transfer_ref };
      },
    );
  }

  waive(actor: PlatformActor, invoiceId: string, note: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string }) => ({ action: 'invoice.waive', tenantId: kq.tenantId, detail: { invoiceId, note } }),
      async (tx) => {
        const b = await this.hoaDon(tx, invoiceId);
        await sql`SELECT saas_settle_invoice(${invoiceId}::uuid, 'WAIVED', ${actor.identityId}::uuid, NULL, NULL, ${note}::text)`
          .execute(tx)
          .catch(dichLoi);
        return { tenantId: b.tenant_id };
      },
    );
  }

  void(actor: PlatformActor, invoiceId: string, note: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string }) => ({ action: 'invoice.void', tenantId: kq.tenantId, detail: { invoiceId, note } }),
      async (tx) => {
        const b = await this.hoaDon(tx, invoiceId);
        const r = await tx
          .updateTable('tenant_billing_record')
          .set({ status: 'VOID', note })
          .where('id', '=', invoiceId)
          .where('status', '=', 'PENDING')
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) === 0) {
          throw new ConflictException({ code: 'INVOICE_NOT_PENDING', message: 'Chỉ huỷ được hoá đơn đang chờ thanh toán.' });
        }
        return { tenantId: b.tenant_id };
      },
    );
  }

  // ---- Yêu cầu đổi gói ---------------------------------------------------------

  planRequests(actor: PlatformActor, status?: string): Promise<PlatformPlanRequestRow[]> {
    return this.pdb.run(
      actor,
      'SUPPORT',
      (rows: PlatformPlanRequestRow[]) => ({ action: 'plan_request.list', detail: { status: status ?? null, count: rows.length } }),
      async (tx) => {
        let q = tx
          .selectFrom('plan_change_request as r')
          .innerJoin('tenant as t', 't.id', 'r.tenant_id')
          .innerJoin('plan as pf', 'pf.code', 'r.from_plan')
          .innerJoin('plan as pt', 'pt.code', 'r.to_plan')
          .innerJoin('identity as rq', 'rq.id', 'r.requested_by')
          .leftJoin('identity as dc', 'dc.id', 'r.decided_by')
          .select([
            'r.id', 'r.tenant_id', 't.name as tenant_name', 'r.from_plan', 'pf.name as from_name',
            'pf.price_monthly as from_price', 'r.to_plan', 'pt.name as to_name', 'pt.price_monthly as to_price',
            'pt.max_members as to_members', 'pt.max_trainers as to_trainers', 'r.note', 'r.status',
            'rq.full_name as requested_by_name', 'r.created_at', 'dc.full_name as decided_by_name',
            'r.decided_at', 'r.decision_note',
          ]);
        if (status) q = q.where('r.status', '=', status);
        const rows = await q
          .orderBy(sql`CASE WHEN r.status = 'PENDING' THEN 0 ELSE 1 END`)
          .orderBy('r.created_at', 'desc')
          .limit(200)
          .execute();

        // Chỉ yêu cầu đang chờ mới cần biết "gói đích có chứa nổi phòng này không".
        const cho = [...new Set(rows.filter((r) => r.status === 'PENDING').map((r) => r.tenant_id))];
        const suDung = new Map<string, SaasUsage>();
        for (const id of cho) {
          const [t] = await this.dsPhong(tx, { id });
          if (t) suDung.set(id, t.usage);
        }

        return rows.map((r) => {
          const u = r.status === 'PENDING' ? suDung.get(r.tenant_id) : undefined;
          const vuot: string[] = [];
          if (u && r.to_members !== null && u.members.used > r.to_members) vuot.push(`${u.members.used}/${r.to_members} hội viên`);
          if (u && r.to_trainers !== null && u.trainers.used > r.to_trainers) vuot.push(`${u.trainers.used}/${r.to_trainers} HLV`);
          return {
            id: r.id,
            tenantId: r.tenant_id,
            tenantName: r.tenant_name,
            fromPlan: r.from_plan,
            fromPlanName: r.from_name,
            fromPrice: Number(r.from_price),
            toPlan: r.to_plan,
            toPlanName: r.to_name,
            toPrice: Number(r.to_price),
            note: r.note,
            status: r.status as PlanRequestStatus,
            requestedByName: r.requested_by_name,
            createdAt: iso(r.created_at),
            decidedByName: r.decided_by_name,
            decidedAt: r.decided_at ? iso(r.decided_at) : null,
            decisionNote: r.decision_note,
            overLimit: vuot,
          };
        });
      },
    );
  }

  /**
   * Duyệt: đổi gói NGAY (hạn mức mới có hiệu lực luôn), giá mới áp từ hoá đơn
   * kỳ sau. Không tính chênh lệch giữa kỳ — đã chốt với chủ sản phẩm.
   */
  approvePlanRequest(actor: PlatformActor, id: string, note?: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string; from: string; to: string }) => ({
        action: 'plan_request.approve',
        tenantId: kq.tenantId,
        detail: { from: kq.from, to: kq.to, note: note ?? null },
      }),
      async (tx) => {
        const r = await this.khoaYeuCau(tx, id);
        const from = await this.doiGoi(tx, r.tenant_id, r.to_plan, r.from_plan);
        await tx
          .updateTable('plan_change_request')
          .set({ status: 'APPROVED', decided_by: actor.identityId, decided_at: new Date(), decision_note: note || null })
          .where('id', '=', id)
          .execute();
        return { tenantId: r.tenant_id, from, to: r.to_plan };
      },
    );
  }

  rejectPlanRequest(actor: PlatformActor, id: string, note: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string; to: string }) => ({ action: 'plan_request.reject', tenantId: kq.tenantId, detail: { to: kq.to, note } }),
      async (tx) => {
        const r = await this.khoaYeuCau(tx, id);
        await tx
          .updateTable('plan_change_request')
          .set({ status: 'REJECTED', decided_by: actor.identityId, decided_at: new Date(), decision_note: note })
          .where('id', '=', id)
          .execute();
        return { tenantId: r.tenant_id, to: r.to_plan };
      },
    );
  }

  // ---- Giao dịch ngân hàng -----------------------------------------------------

  /**
   * Webhook SePay đã qua kiểm khoá API. Không có người thao tác: việc khớp và
   * ghi nhật ký nằm trong hàm SQL saas_ingest_bank_txn (0017).
   */
  ingestBankTxn(t: {
    provider: 'SEPAY';
    txnId: string;
    direction: 'IN' | 'OUT';
    amount: number;
    content: string;
    accountNo: string | null;
    bankRef: string | null;
    txnAt: string | null;
    payload: unknown;
  }) {
    return this.pdb.ingestBankTxn(t);
  }

  bankTxns(actor: PlatformActor, f: { view: 'OPEN' | 'ALL' }): Promise<BankTxnRow[]> {
    return this.pdb.run(
      actor,
      'SUPPORT',
      (rows: BankTxnRow[]) => ({ action: 'bank.list', detail: { view: f.view, count: rows.length } }),
      async (tx) => {
        let q = tx
          .selectFrom('bank_txn_event as e')
          .leftJoin('tenant_billing_record as b', 'b.id', 'e.invoice_id')
          .leftJoin('tenant as t', 't.id', 'e.matched_tenant')
          .leftJoin('identity as rv', 'rv.id', 'e.resolved_by')
          .select([
            'e.id', 'e.provider', 'e.provider_txn_id', 'e.amount', 'e.content', 'e.txn_at', 'e.received_at',
            'e.outcome', 'e.invoice_id', 'b.amount as invoice_amount', 'b.transfer_ref', 'e.matched_tenant',
            't.name as tenant_name', 'e.resolved_at', 'rv.full_name as resolved_by_name', 'e.resolve_note',
          ]);
        if (f.view === 'OPEN') {
          q = q.where('e.outcome', 'not in', ['MATCHED', 'IGNORED']).where('e.resolved_at', 'is', null);
        }
        const rows = await q.orderBy('e.received_at', 'desc').limit(200).execute();
        return rows.map((r) => ({
          id: String(r.id),
          provider: r.provider,
          providerTxnId: r.provider_txn_id,
          amount: Number(r.amount),
          content: r.content,
          txnAt: r.txn_at ? iso(r.txn_at) : null,
          receivedAt: iso(r.received_at),
          outcome: r.outcome as BankTxnOutcome,
          invoiceId: r.invoice_id,
          invoiceAmount: r.invoice_amount === null ? null : Number(r.invoice_amount),
          transferRef: r.transfer_ref,
          tenantId: r.matched_tenant,
          tenantName: r.tenant_name,
          resolvedAt: r.resolved_at ? iso(r.resolved_at) : null,
          resolvedByName: r.resolved_by_name,
          resolveNote: r.resolve_note,
        }));
      },
    );
  }

  /** "Đã xử lý" một giao dịch không tự khớp: đã xác nhận tay, đã hoàn tiền, hoặc không phải tiền gói. */
  resolveBankTxn(actor: PlatformActor, id: string, note: string) {
    return this.pdb.run(
      actor,
      'OPS',
      (kq: { tenantId: string | null; amount: number }) => ({
        action: 'bank.resolve',
        tenantId: kq.tenantId,
        detail: { amount: kq.amount, note },
      }),
      async (tx) => {
        const r = await tx
          .updateTable('bank_txn_event')
          .set({ resolved_by: actor.identityId, resolved_at: new Date(), resolve_note: note })
          .where('id', '=', id)
          .where('resolved_at', 'is', null)
          .where('outcome', 'not in', ['MATCHED', 'IGNORED'])
          .returning(['matched_tenant', 'amount'])
          .executeTakeFirst();
        if (!r) {
          throw new ConflictException({ code: 'BANK_TXN_NOT_OPEN', message: 'Giao dịch này đã được xử lý, hoặc đã tự khớp.' });
        }
        return { tenantId: r.matched_tenant, amount: Number(r.amount) };
      },
    );
  }

  // ---- Tài khoản quản trị nền tảng (SUPER) -------------------------------------

  admins(actor: PlatformActor): Promise<PlatformAdminRow[]> {
    return this.pdb.run(actor, 'SUPER', { action: 'admin.list' }, async (tx) => {
      const rows = await tx
        .selectFrom('platform_admin as a')
        .innerJoin('identity as i', 'i.id', 'a.identity_id')
        .select(['a.identity_id', 'i.full_name', 'i.phone', 'a.level', 'a.created_at', 'i.last_login_at', 'i.must_change_password'])
        .orderBy(sql`CASE a.level WHEN 'SUPER' THEN 0 WHEN 'OPS' THEN 1 ELSE 2 END`)
        .orderBy('i.full_name')
        .execute();
      return rows.map((r) => ({
        identityId: r.identity_id,
        fullName: r.full_name,
        phone: r.phone,
        level: r.level as PlatformLevel,
        createdAt: iso(r.created_at),
        lastLoginAt: r.last_login_at ? iso(r.last_login_at) : null,
        mustChangePassword: r.must_change_password,
      }));
    });
  }

  /**
   * Cấp quyền quản trị cho một số điện thoại. Đã có tài khoản (đang là chủ
   * phòng, PT...) thì dùng lại — một người, một tài khoản. Chưa có mật khẩu thì
   * sinh mật khẩu tạm, bắt đổi ở lần đăng nhập đầu.
   */
  addAdmin(actor: PlatformActor, req: AddPlatformAdminRequest): Promise<AddPlatformAdminResult> {
    return this.pdb.run(
      actor,
      'SUPER',
      (kq: AddPlatformAdminResult) => ({
        action: 'admin.add',
        detail: { phone: req.phone, level: req.level, identityId: kq.identityId, newPassword: kq.tempPassword !== null },
      }),
      async (tx) => {
        let idn = await tx
          .selectFrom('identity')
          .select(['id', 'password_hash', 'status'])
          .where('phone', '=', req.phone)
          .executeTakeFirst();
        if (idn && idn.status !== 'ACTIVE') {
          throw new BadRequestException({ code: 'ACCOUNT_LOCKED', message: 'Tài khoản của số điện thoại này đang bị khoá.' });
        }
        let tempPassword: string | null = null;
        if (!idn || !idn.password_hash) {
          tempPassword = randomBytes(9).toString('base64url');
          const hash = await bcrypt.hash(tempPassword, 10);
          if (idn) {
            await tx.updateTable('identity').set({ password_hash: hash, must_change_password: true }).where('id', '=', idn.id).execute();
          } else {
            idn = await tx
              .insertInto('identity')
              .values({ phone: req.phone, full_name: req.fullName, password_hash: hash, must_change_password: true })
              .returning(['id', 'password_hash', 'status'])
              .executeTakeFirstOrThrow();
          }
        }
        const daCo = await tx.selectFrom('platform_admin').select('level').where('identity_id', '=', idn.id).executeTakeFirst();
        if (daCo) {
          throw new ConflictException({ code: 'ALREADY_ADMIN', message: `Số này đã là quản trị viên (cấp ${daCo.level}).` });
        }
        await tx.insertInto('platform_admin').values({ identity_id: idn.id, level: req.level }).execute();
        return { identityId: idn.id, tempPassword };
      },
    );
  }

  changeAdminLevel(actor: PlatformActor, identityId: string, level: PlatformLevel) {
    return this.pdb.run(
      actor,
      'SUPER',
      (kq: { from: string }) => ({ action: 'admin.change_level', detail: { identityId, from: kq.from, to: level } }),
      async (tx) => {
        const cu = await this.khoaQuanTri(tx, identityId);
        if (cu === level) throw new BadRequestException({ code: 'SAME_LEVEL', message: 'Người này đang ở đúng cấp đó.' });
        if (cu === 'SUPER' && level !== 'SUPER') await this.conSuperKhac(tx, identityId, actor);
        await tx.updateTable('platform_admin').set({ level }).where('identity_id', '=', identityId).execute();
        return { from: cu };
      },
    );
  }

  /**
   * Thu quyền: xoá khỏi platform_admin VÀ thu hồi phiên nền tảng đang mở. Tài
   * khoản (định danh) giữ nguyên — người đó có thể vẫn là chủ phòng tập nào đó.
   */
  revokeAdmin(actor: PlatformActor, identityId: string) {
    return this.pdb.run(
      actor,
      'SUPER',
      (kq: { level: string }) => ({ action: 'admin.revoke', detail: { identityId, level: kq.level } }),
      async (tx) => {
        const cu = await this.khoaQuanTri(tx, identityId);
        if (cu === 'SUPER') await this.conSuperKhac(tx, identityId, actor);
        await tx.deleteFrom('platform_admin').where('identity_id', '=', identityId).execute();
        await tx
          .updateTable('refresh_token')
          .set({ revoked_at: new Date(), revoked_reason: 'LOGOUT' })
          .where('identity_id', '=', identityId)
          .where('tenant_id', 'is', null)
          .where('revoked_at', 'is', null)
          .execute();
        return { level: cu };
      },
    );
  }

  // ---- Nội bộ ------------------------------------------------------------------

  /**
   * Đổi gói một phòng, trả mã gói cũ. `expectFrom`: gói phòng PHẢI đang dùng —
   * duyệt một yêu cầu cũ sau khi gói đã bị đổi tay là duyệt trên dữ liệu sai.
   *
   * Hạn mức đổi NGAY. Hoá đơn đang mở giữ giá cũ — muốn thu theo giá mới thì
   * huỷ hoá đơn đó, job sẽ phát hành lại theo gói mới.
   */
  private async doiGoi(tx: PTx, tenantId: string, planCode: string, expectFrom?: string): Promise<string> {
    const sub = await this.khoaThueBao(tx, tenantId);
    const plan = await tx.selectFrom('plan').select('code').where('code', '=', planCode).executeTakeFirst();
    if (!plan) throw new BadRequestException({ code: 'PLAN_NOT_FOUND', message: 'Gói không tồn tại.' });
    if (expectFrom && sub.plan_code !== expectFrom) {
      throw new ConflictException({
        code: 'PLAN_CHANGED_SINCE_REQUEST',
        message: 'Gói của phòng đã thay đổi kể từ lúc gửi yêu cầu. Từ chối yêu cầu này và nhờ chủ phòng gửi lại.',
      });
    }
    if (sub.plan_code === planCode) {
      throw new BadRequestException({ code: 'SAME_PLAN', message: 'Phòng đang dùng đúng gói này.' });
    }
    await tx.updateTable('tenant_subscription').set({ plan_code: planCode }).where('tenant_id', '=', tenantId).execute();
    return sub.plan_code;
  }

  private async khoaYeuCau(tx: PTx, id: string) {
    const r = await tx
      .selectFrom('plan_change_request')
      .select(['id', 'tenant_id', 'from_plan', 'to_plan', 'status'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) throw new NotFoundException('PLAN_REQUEST_NOT_FOUND');
    if (r.status !== 'PENDING') {
      throw new ConflictException({ code: 'PLAN_REQUEST_NOT_PENDING', message: 'Yêu cầu này đã được xử lý (có thể ở tab khác, hoặc chủ phòng đã huỷ).' });
    }
    return r;
  }

  private async khoaQuanTri(tx: PTx, identityId: string): Promise<string> {
    const a = await tx.selectFrom('platform_admin').select('level').where('identity_id', '=', identityId).forUpdate().executeTakeFirst();
    if (!a) throw new NotFoundException('ADMIN_NOT_FOUND');
    return a.level;
  }

  /**
   * Không được bỏ đi SUPER cuối cùng (nền tảng không còn ai cấp quyền được nữa,
   * phải sửa bằng SQL), và không tự hạ / thu quyền của chính mình — nhờ một
   * SUPER khác làm, để luôn có người thứ hai biết.
   */
  private async conSuperKhac(tx: PTx, identityId: string, actor: PlatformActor): Promise<void> {
    if (identityId === actor.identityId) {
      throw new ForbiddenException({ code: 'CANNOT_DEMOTE_SELF', message: 'Không tự hạ cấp hay thu quyền của chính mình. Nhờ một quản trị viên toàn quyền khác.' });
    }
    const supers = await tx
      .selectFrom('platform_admin')
      .select('identity_id')
      .where('level', '=', 'SUPER')
      .forUpdate()
      .execute();
    if (supers.filter((s) => s.identity_id !== identityId).length === 0) {
      throw new ConflictException({ code: 'LAST_SUPER', message: 'Đây là quản trị viên toàn quyền cuối cùng.' });
    }
  }

  private async dsPhong(tx: PTx, f: { q?: string; status?: string; id?: string }): Promise<PlatformTenantRow[]> {
    let q = tx
      .selectFrom('tenant as t')
      .innerJoin('tenant_subscription as s', 's.tenant_id', 't.id')
      .innerJoin('plan as p', 'p.code', 's.plan_code')
      .select([
        't.id',
        't.slug',
        't.name',
        't.status',
        't.status_note',
        't.created_at',
        's.plan_code',
        'p.name as plan_name',
        's.status as sub_status',
        's.current_period_end',
        'p.max_members',
        'p.max_trainers',
        'p.max_messages_month',
        sql<string>`(SELECT coalesce(sum(b.amount), 0) FROM tenant_billing_record b
                     WHERE b.tenant_id = t.id AND b.status = 'PENDING')`.as('open_amount'),
      ]);
    if (f.id) q = q.where('t.id', '=', f.id);
    if (f.status) q = q.where('t.status', '=', f.status);
    if (f.q?.trim()) {
      const k = `%${f.q.trim()}%`;
      q = q.where((eb) => eb.or([eb('t.name', 'ilike', k), eb(sql`t.slug::text`, 'ilike', k)]));
    }
    const rows = await q.orderBy('t.created_at', 'desc').limit(500).execute();
    if (rows.length === 0) return [];

    const ids = rows.map((r) => r.id);
    // Đếm ĐÚNG như assert_quota (0007) — xem SubscriptionService.suDung.
    // Tuần tự: ba câu cùng một transaction = cùng một kết nối.
    const hv = await tx.selectFrom('member').select(['tenant_id', sql<number>`count(*)::int`.as('n')])
      .where('tenant_id', 'in', ids).where('status', '<>', 'BANNED').groupBy('tenant_id').execute();
    const pt = await tx.selectFrom('trainer').select(['tenant_id', sql<number>`count(*)::int`.as('n')])
      .where('tenant_id', 'in', ids).where('status', '=', 'ACTIVE').groupBy('tenant_id').execute();
    const tin = await tx.selectFrom('tenant_message_usage').select(['tenant_id', sql<number>`sum(sent_count)::int`.as('n')])
      .where('tenant_id', 'in', ids).where('channel', '=', 'ZALO_ZNS').where('period_month', '=', THANG_VN)
      .groupBy('tenant_id').execute();
    const dem = (xs: { tenant_id: string; n: number }[]) => new Map(xs.map((x) => [x.tenant_id, Number(x.n)]));
    const [mHv, mPt, mTin] = [dem(hv), dem(pt), dem(tin)];

    return rows.map((r) => {
      const usage: SaasUsage = {
        members: { used: mHv.get(r.id) ?? 0, limit: r.max_members },
        trainers: { used: mPt.get(r.id) ?? 0, limit: r.max_trainers },
        messages: { used: mTin.get(r.id) ?? 0, limit: r.max_messages_month },
      };
      return {
        id: r.id,
        slug: String(r.slug),
        name: r.name,
        status: r.status as TenantStatus,
        statusNote: r.status_note,
        createdAt: iso(r.created_at),
        planCode: r.plan_code,
        planName: r.plan_name,
        subscriptionStatus: r.sub_status as SubscriptionStatus,
        paidThrough: r.current_period_end,
        usage,
        openAmount: Number(r.open_amount),
      };
    });
  }

  private async nhatKy(
    tx: PTx,
    f: { tenantId?: string; size: number; offset: number },
  ): Promise<{ items: PlatformAuditRow[]; total: number }> {
    let q = tx
      .selectFrom('platform_audit_log as a')
      .leftJoin('identity as i', 'i.id', 'a.actor_id')
      .leftJoin('tenant as t', 't.id', 'a.target_tenant');
    if (f.tenantId) q = q.where('a.target_tenant', '=', f.tenantId);
    const tong = await q.select(sql<number>`count(*)::int`.as('n')).executeTakeFirst();
    const rows = await q
      .select(['a.id', 'a.created_at', 'i.full_name', 'a.target_tenant', 't.name as tenant_name', 'a.action', 'a.detail', 'a.ip'])
      .orderBy('a.id', 'desc')
      .limit(f.size)
      .offset(f.offset)
      .execute();
    return {
      total: Number(tong?.n ?? 0),
      items: rows.map((r) => ({
        id: String(r.id),
        createdAt: iso(r.created_at),
        actorName: r.full_name,
        tenantId: r.target_tenant,
        tenantName: r.tenant_name,
        action: r.action,
        detail: (typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail) as Record<string, unknown>,
        ip: r.ip,
      })),
    };
  }

  /** Khoá dòng phòng tập (FOR UPDATE) để hai người vận hành không dẫm nhau. */
  private async khoaPhong(tx: PTx, id: string) {
    const t = await tx.selectFrom('tenant').select(['id', 'status']).where('id', '=', id).forUpdate().executeTakeFirst();
    if (!t) throw new NotFoundException('TENANT_NOT_FOUND');
    return t;
  }

  private async khoaVi(tx: PTx, id: string): Promise<string | null> {
    const t = await tx.selectFrom('tenant').select('suspend_kind').where('id', '=', id).executeTakeFirst();
    return t?.suspend_kind ?? null;
  }

  private async khoaThueBao(tx: PTx, id: string) {
    const s = await tx
      .selectFrom('tenant_subscription')
      .select(['plan_code', 'status'])
      .where('tenant_id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw new NotFoundException('TENANT_NOT_FOUND');
    return s;
  }

  private async hoaDon(tx: PTx, id: string) {
    const b = await tx
      .selectFrom('tenant_billing_record')
      .select(['id', 'tenant_id', 'amount', 'status', 'transfer_ref'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!b) throw new NotFoundException('INVOICE_NOT_FOUND');
    return b;
  }
}

