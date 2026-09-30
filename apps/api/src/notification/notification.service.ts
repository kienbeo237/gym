import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CampaignPreview,
  CampaignRow,
  CampaignRunResult,
  CreateCampaignRequest,
  ListOutboxQuery,
  OutboxRow,
  OutboxStats,
  OutboxStatus,
  Paged,
  UpdateCampaignRequest,
} from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { RateLimitService } from '../redis/rate-limit.service';
import { tenantKey } from '../redis/redis-keys';
import { CampaignRunner } from './campaign-runner.service';
import { MAU_TIN, laMaMau } from './templates';

/** Màn Tin nhắn và Chiến dịch — mọi thứ chạy trong request, tenant lấy từ token. */
@Injectable()
export class NotificationService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly runner: CampaignRunner,
    private readonly rate: RateLimitService,
  ) {}

  // ---- Hộp thư đi --------------------------------------------------------------

  async listOutbox(q: ListOutboxQuery): Promise<Paged<OutboxRow>> {
    return this.tdb.run(async (tx) => {
      let base = tx.selectFrom('notification_outbox as o');
      if (q.status) base = base.where('o.status', '=', q.status);

      const [{ n }] = (await base.select((eb) => eb.fn.countAll<string>().as('n')).execute()) as [{ n: string }];
      const rows = await base
        .leftJoin('member as m', 'm.id', 'o.member_id')
        .leftJoin('identity as i', 'i.id', 'm.identity_id')
        .select([
          'o.id', 'o.channel', 'o.template_code', 'o.member_id', 'o.status', 'o.attempts', 'o.last_error',
          'o.created_at', 'o.sent_at', 'o.delivered_at', 'o.next_attempt_at', 'i.full_name', 'm.code as member_code',
        ])
        .orderBy('o.id', 'desc')
        .limit(q.size)
        .offset((q.page - 1) * q.size)
        .execute();

      return {
        items: rows.map((r) => ({
          id: String(r.id),
          channel: r.channel as OutboxRow['channel'],
          templateCode: r.template_code,
          templateName: laMaMau(r.template_code) ? MAU_TIN[r.template_code].name : r.template_code,
          memberId: r.member_id,
          memberName: r.full_name,
          memberCode: r.member_code,
          status: r.status as OutboxStatus,
          attempts: r.attempts,
          lastError: r.last_error,
          createdAt: new Date(r.created_at).toISOString(),
          sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
          deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
          nextAttemptAt: new Date(r.next_attempt_at).toISOString(),
        })),
        page: q.page,
        size: q.size,
        total: Number(n),
      };
    });
  }

  async stats(): Promise<OutboxStats> {
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('notification_outbox')
        .select(['status', (eb) => eb.fn.countAll<string>().as('n')])
        .where('created_at', '>', sql<Date>`now() - interval '30 days'`)
        .groupBy('status')
        .execute();
      const byStatus: OutboxStats['byStatus'] = { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0, SKIPPED: 0 };
      for (const r of rows) byStatus[r.status as OutboxStatus] = Number(r.n);

      const u = await tx
        .selectFrom('tenant_message_usage')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<string>('sent_count'), eb.val('0')).as('n'))
        .where('period_month', '=', sql<string>`date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`)
        .executeTakeFirst();
      return { byStatus, sentThisMonth: Number(u?.n ?? 0) };
    });
  }

  /**
   * Gửi lại tin FAILED / SKIPPED — sau khi đã sửa nguyên nhân (kết nối OA, khai
   * mã mẫu). Reset bộ đếm thử và hạn gửi; tin đã quá hạn thì worker sẽ lại bỏ
   * qua với lý do rõ ràng, không gửi thông tin cũ.
   */
  async retry(id: string): Promise<{ ok: true }> {
    const kq = await this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('notification_outbox')
        .set({ status: 'PENDING', attempts: 0, next_attempt_at: new Date(), last_error: null })
        .where('id', '=', id)
        .where('status', 'in', ['FAILED', 'SKIPPED'])
        // OTP không bao giờ gửi lại: mã đã bị xoá khỏi payload, và đã hết hạn.
        .where('template_code', '<>', 'OTP_LOGIN')
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) > 0) return 'ok';
      // Tin của phòng khác: RLS giấu nó, nên với phòng này nó KHÔNG tồn tại.
      const co = await tx.selectFrom('notification_outbox').select('id').where('id', '=', id).executeTakeFirst();
      return co ? 'conflict' : 'missing';
    });
    if (kq === 'missing') throw new NotFoundException({ code: 'OUTBOX_NOT_FOUND', message: 'Không tìm thấy tin' });
    if (kq === 'conflict') {
      throw new ConflictException({ code: 'OUTBOX_NOT_RETRYABLE', message: 'Chỉ gửi lại được tin lỗi hoặc bị bỏ qua' });
    }
    return { ok: true };
  }

  // ---- Chiến dịch ------------------------------------------------------------------

  async listCampaigns(): Promise<CampaignRow[]> {
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('campaign as c')
        .leftJoin(
          (eb) =>
            eb
              .selectFrom('campaign_enrollment')
              .select([
                'campaign_id',
                (e) => e.fn.max('triggered_at').as('last_at'),
              ])
              .groupBy('campaign_id')
              .as('e'),
          (j) => j.onRef('e.campaign_id', '=', 'c.id'),
        )
        .select([
          'c.id', 'c.code', 'c.name', 'c.trigger_type', 'c.threshold', 'c.channel', 'c.template_code',
          'c.is_active', 'c.cooldown_days', 'e.last_at',
          // Đếm theo payload.campaignId: chiến dịch sinh nhật / trả góp không có enrollment.
          sql<string>`(SELECT count(*) FROM notification_outbox o
                        WHERE o.payload->>'campaignId' = c.id::text
                          AND o.created_at > now() - interval '30 days')`.as('sent30d'),
        ])
        .orderBy('c.created_at')
        .execute();
      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        triggerType: r.trigger_type as CampaignRow['triggerType'],
        threshold: r.threshold,
        channel: r.channel as CampaignRow['channel'],
        templateCode: r.template_code,
        isActive: r.is_active,
        cooldownDays: r.cooldown_days,
        sent30d: Number(r.sent30d),
        lastTriggeredAt: r.last_at ? new Date(r.last_at).toISOString() : null,
      }));
    });
  }

  async createCampaign(dto: CreateCampaignRequest): Promise<CampaignRow[]> {
    const { tenantId } = requireContext();
    try {
      await this.tdb.run((tx) =>
        tx
          .insertInto('campaign')
          .values({
            tenant_id: tenantId,
            code: dto.code,
            name: dto.name,
            trigger_type: dto.triggerType,
            threshold: dto.threshold,
            channel: 'ZALO_ZNS',
            template_code: dto.templateCode,
            is_active: dto.isActive,
            cooldown_days: dto.cooldownDays,
          })
          .execute(),
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException({ code: 'CAMPAIGN_CODE_TAKEN', message: `Mã chiến dịch ${dto.code} đã có` });
      }
      throw e;
    }
    return this.listCampaigns();
  }

  async updateCampaign(id: string, dto: UpdateCampaignRequest): Promise<CampaignRow[]> {
    const set = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.threshold !== undefined ? { threshold: dto.threshold } : {}),
      ...(dto.cooldownDays !== undefined ? { cooldown_days: dto.cooldownDays } : {}),
      ...(dto.templateCode !== undefined ? { template_code: dto.templateCode } : {}),
      ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
    };
    if (Object.keys(set).length === 0) throw new BadRequestException({ code: 'NOTHING_TO_UPDATE', message: 'Không có gì để sửa' });

    const r = await this.tdb.run((tx) => tx.updateTable('campaign').set(set).where('id', '=', id).executeTakeFirst());
    if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('CAMPAIGN_NOT_FOUND');
    return this.listCampaigns();
  }

  async preview(id: string): Promise<CampaignPreview> {
    const { tenantId } = requireContext();
    const p = await this.runner.preview(tenantId, id);
    if (!p) throw new NotFoundException('CAMPAIGN_NOT_FOUND');
    return p;
  }

  /** "Chạy ngay" — cùng đường với job định kỳ, giới hạn 1 lần / phút / phòng. */
  async runNow(): Promise<CampaignRunResult> {
    const { tenantId } = requireContext();
    const v = await this.rate.hit(tenantKey(tenantId, 'campaign', 'run'), 1, 60);
    if (!v.allowed) {
      throw new BadRequestException({
        code: 'CAMPAIGN_RUN_TOO_SOON',
        message: `Vừa chạy xong. Thử lại sau ${v.retryAfterSeconds} giây.`,
      });
    }
    return this.runner.runTenant(tenantId);
  }
}
