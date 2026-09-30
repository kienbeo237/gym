import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { CampaignPreview } from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { MAU_TIN, laMaMau } from './templates';
import { hanMucTinThang, hetHanMuc } from './quota';

const TZ = 'Asia/Ho_Chi_Minh';
/** Không nhắn khách ngoài khung này (giờ VN). Tin tạo ngoài giờ được hẹn tới sáng. */
const GIO_BAT_DAU = 8;
const GIO_KET_THUC = 21;

type Campaign = {
  id: string;
  code: string;
  trigger_type: string;
  threshold: number;
  channel: string;
  template_code: string;
  cooldown_days: number;
};

/** Một người thoả điều kiện của chiến dịch. */
type Muc = {
  memberId: string;
  memberName: string;
  /** Có = chống lặp bằng campaign_enrollment (có thời gian chờ). */
  memberPackageId: string | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  detail: string;
};

export function homNayVN(now = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** Thời điểm được phép gửi gần nhất tính từ `now`, theo khung giờ VN. */
export function gioGuiHopLe(now = new Date()): Date {
  const gio = Number(now.toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
  if (gio >= GIO_BAT_DAU && gio < GIO_KET_THUC) return now;
  // Việt Nam không có giờ mùa hè: +07:00 cố định, dựng thẳng được.
  const ngay = gio >= GIO_KET_THUC ? homNayVN(new Date(now.getTime() + 24 * 3600_000)) : homNayVN(now);
  return new Date(`${ngay}T${String(GIO_BAT_DAU).padStart(2, '0')}:00:00+07:00`);
}

/**
 * Chạy chiến dịch chăm sóc của MỘT phòng tập.
 *
 * Chạy nhiều lần trong ngày là AN TOÀN — và đó là chủ ý: job chạy mỗi 30 phút
 * trong giờ hành chính nên gói vừa chạm ngưỡng lúc trưa được nhắc ngay chiều
 * đó, không phải chờ sáng mai. Ba lớp chống gửi trùng:
 *
 *   1. campaign_enrollment (chiến dịch, gói) + cooldown_days — nhắc lại theo
 *      chu kỳ, hoặc chỉ một lần mỗi gói (cooldown = 0)
 *   2. idempotency_key của outbox — chống trùng cho sinh nhật / trả góp, nơi
 *      không có gói để neo, và là lưới cuối cho cả hai loại kia
 *   3. khoá Redis theo phòng ở tầng lịch chạy — hai worker không chạy chồng
 *
 * Chiến dịch CHƯA sẵn sàng (OA chưa kết nối, mẫu chưa duyệt) thì KHÔNG xếp tin
 * và không ghi enrollment: xếp vào chỉ sinh hàng loạt dòng SKIPPED, còn ghi
 * enrollment thì tới lúc kết nối xong hội viên đó sẽ không bao giờ được nhắc.
 */
@Injectable()
export class CampaignRunner {
  private readonly log = new Logger(CampaignRunner.name);

  constructor(private readonly tdb: TenantDb) {}

  /** Chạy mọi chiến dịch đang bật của phòng. Trả về số tin đã xếp hàng. */
  async runTenant(tenantId: string, now = new Date()): Promise<{ campaigns: number; queued: number }> {
    return this.tdb.runAs(tenantId, async (tx) => {
      const ds = await this.chienDich(tx, { onlyActive: true });
      let queued = 0;
      for (const c of ds) {
        if (await this.lyDoChan(tx, c)) continue;
        queued += (await this.chayMot(tx, tenantId, c, now, false)).queued;
      }
      if (queued > 0) this.log.log(`Phòng ${tenantId}: xếp ${queued} tin chiến dịch`);
      return { campaigns: ds.length, queued };
    });
  }

  /** Xem trước một chiến dịch — KHÔNG ghi gì. */
  async preview(tenantId: string, campaignId: string, now = new Date()): Promise<CampaignPreview | null> {
    return this.tdb.runAs(tenantId, async (tx) => {
      const [c] = await this.chienDich(tx, { id: campaignId });
      if (!c) return null;
      const r = await this.chayMot(tx, tenantId, c, now, true);
      return {
        matched: r.matched,
        willSend: r.queued,
        sample: r.sample,
        blockedReason: await this.lyDoChan(tx, c),
      };
    });
  }

  private chienDich(tx: Tx, f: { onlyActive?: boolean; id?: string }): Promise<Campaign[]> {
    let q = tx
      .selectFrom('campaign')
      .select(['id', 'code', 'trigger_type', 'threshold', 'channel', 'template_code', 'cooldown_days'])
      .orderBy('code');
    if (f.onlyActive) q = q.where('is_active', '=', true);
    if (f.id) q = q.where('id', '=', f.id);
    return q.execute();
  }

  private async lyDoChan(tx: Tx, c: Campaign): Promise<string | null> {
    if (!laMaMau(c.template_code)) return `Mẫu tin "${c.template_code}" không có trong danh mục`;
    if (c.channel === 'INAPP') return null;
    if (c.channel !== 'ZALO_ZNS') return `Kênh ${c.channel} chưa được hỗ trợ`;

    const hm = await hanMucTinThang(tx);
    if (hetHanMuc(hm)) return `Đã dùng hết ${hm.limit} tin Zalo của gói trong tháng này — nâng gói để gửi tiếp`;

    const oa = await tx.selectFrom('tenant_zalo_oa').select('status').executeTakeFirst();
    if (oa?.status !== 'CONNECTED') return 'Zalo OA chưa kết nối';
    const mau = await tx
      .selectFrom('tenant_zns_template')
      .select('status')
      .where('template_code', '=', c.template_code)
      .executeTakeFirst();
    if (mau?.status !== 'APPROVED') return `Mẫu "${MAU_TIN[c.template_code].name}" chưa khai mã Zalo đã duyệt`;
    return null;
  }

  private async chayMot(
    tx: Tx,
    tenantId: string,
    c: Campaign,
    now: Date,
    dryRun: boolean,
  ): Promise<{ matched: number; queued: number; sample: CampaignPreview['sample'] }> {
    const muc = await this.timDoiTuong(tx, c, homNayVN(now));
    const guiLuc = gioGuiHopLe(now);
    const sample: CampaignPreview['sample'] = [];
    let queued = 0;

    for (const m of muc) {
      if (m.memberPackageId && (await this.dangCho(tx, c, m.memberPackageId, now))) continue;

      if (dryRun) {
        const daCo = await tx
          .selectFrom('notification_outbox')
          .select('id')
          .where('idempotency_key', '=', m.idempotencyKey)
          .executeTakeFirst();
        if (daCo) continue;
        queued++;
        if (sample.length < 8) sample.push({ memberName: m.memberName, detail: m.detail });
        continue;
      }

      const ins = await tx
        .insertInto('notification_outbox')
        .values({
          tenant_id: tenantId,
          channel: c.channel,
          template_code: c.template_code,
          recipient_ref: m.memberId,
          member_id: m.memberId,
          idempotency_key: m.idempotencyKey,
          payload: JSON.stringify({ ...m.payload, campaignId: c.id }),
          next_attempt_at: guiLuc,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing())
        .returning('id')
        .executeTakeFirst();
      if (!ins) continue;

      if (m.memberPackageId) {
        await tx
          .insertInto('campaign_enrollment')
          .values({
            campaign_id: c.id,
            member_package_id: m.memberPackageId,
            tenant_id: tenantId,
            outbox_id: ins.id,
          })
          .onConflict((oc) =>
            oc.columns(['campaign_id', 'member_package_id']).doUpdateSet({
              triggered_at: sql`now()`,
              outbox_id: ins.id,
            }),
          )
          .execute();
      }
      queued++;
    }
    return { matched: muc.length, queued, sample };
  }

  /** Gói này còn trong thời gian chờ của chiến dịch không? Khoá dòng để hai lần chạy không cùng lọt. */
  private async dangCho(tx: Tx, c: Campaign, mpId: string, now: Date): Promise<boolean> {
    const e = await tx
      .selectFrom('campaign_enrollment')
      .select('triggered_at')
      .where('campaign_id', '=', c.id)
      .where('member_package_id', '=', mpId)
      .forUpdate()
      .executeTakeFirst();
    if (!e) return false;
    // cooldown 0 = mỗi gói chỉ nhắc MỘT lần, mãi mãi.
    if (c.cooldown_days === 0) return true;
    return new Date(e.triggered_at).getTime() > now.getTime() - c.cooldown_days * 86_400_000;
  }

  private async timDoiTuong(tx: Tx, c: Campaign, homNay: string): Promise<Muc[]> {
    const N = c.threshold;
    // Ngày trong khoá chống trùng: chạy lại trong cùng ngày không sinh tin mới.
    const khoaGoi = (mpId: string) => `CAMPAIGN:${c.id}:${mpId}:${homNay}`;

    switch (c.trigger_type) {
      case 'LOW_SESSION_BALANCE': {
        // > 0: gói đã HẾT buổi là chuyện khác (USED_UP), không phải "sắp hết".
        const { rows } = await sql<{
          mp_id: string; member_id: string; full_name: string; package_name: string;
          remaining: number; expires_on: string;
        }>`
          SELECT mp.id AS mp_id, mp.member_id, i.full_name, mp.name_snapshot AS package_name,
                 mp.sessions_remaining AS remaining, mp.expires_on
          FROM member_package mp
          JOIN member m   ON m.id = mp.member_id
          JOIN identity i ON i.id = m.identity_id
          WHERE mp.status = 'ACTIVE' AND m.status = 'ACTIVE'
            AND mp.sessions_remaining > 0 AND mp.sessions_remaining <= ${N}
            AND mp.expires_on >= ${homNay}::date
          ORDER BY mp.sessions_remaining, mp.id
        `.execute(tx);
        return rows.map((r) => ({
          memberId: r.member_id,
          memberName: r.full_name,
          memberPackageId: r.mp_id,
          idempotencyKey: khoaGoi(r.mp_id),
          payload: { packageName: r.package_name, remaining: r.remaining, expiresOn: r.expires_on },
          detail: `${r.package_name} còn ${r.remaining} buổi`,
        }));
      }

      case 'PACKAGE_EXPIRING': {
        const { rows } = await sql<{
          mp_id: string; member_id: string; full_name: string; package_name: string;
          remaining: number; expires_on: string; days_left: number;
        }>`
          SELECT mp.id AS mp_id, mp.member_id, i.full_name, mp.name_snapshot AS package_name,
                 mp.sessions_remaining AS remaining, mp.expires_on,
                 (mp.expires_on - ${homNay}::date) AS days_left
          FROM member_package mp
          JOIN member m   ON m.id = mp.member_id
          JOIN identity i ON i.id = m.identity_id
          WHERE mp.status = 'ACTIVE' AND m.status = 'ACTIVE'
            AND mp.sessions_remaining > 0
            AND mp.expires_on BETWEEN ${homNay}::date AND ${homNay}::date + ${N}::int
          ORDER BY mp.expires_on, mp.id
        `.execute(tx);
        return rows.map((r) => ({
          memberId: r.member_id,
          memberName: r.full_name,
          memberPackageId: r.mp_id,
          idempotencyKey: khoaGoi(r.mp_id),
          payload: {
            packageName: r.package_name, remaining: r.remaining, expiresOn: r.expires_on, daysLeft: r.days_left,
          },
          detail: `${r.package_name} hết hạn sau ${r.days_left} ngày, còn ${r.remaining} buổi`,
        }));
      }

      case 'INACTIVE_MEMBER': {
        // Một người MỘT tin dù có nhiều gói: neo vào gói hết hạn sớm nhất.
        // Chưa từng điểm danh thì tính từ ngày gói bắt đầu.
        const { rows } = await sql<{
          mp_id: string; member_id: string; full_name: string; remaining: number; days_inactive: number;
        }>`
          SELECT * FROM (
            SELECT DISTINCT ON (mp.member_id)
                   mp.id AS mp_id, mp.member_id, i.full_name, mp.sessions_remaining AS remaining,
                   (${homNay}::date - COALESCE(
                      (lc.last_at AT TIME ZONE ${TZ})::date, mp.starts_on)) AS days_inactive
            FROM member_package mp
            JOIN member m   ON m.id = mp.member_id
            JOIN identity i ON i.id = m.identity_id
            LEFT JOIN LATERAL (
              SELECT max(b.checkin_at) AS last_at FROM booking b
              WHERE b.member_id = mp.member_id AND b.checkin_at IS NOT NULL
            ) lc ON true
            WHERE mp.status = 'ACTIVE' AND m.status = 'ACTIVE'
              AND mp.sessions_remaining > 0 AND mp.expires_on >= ${homNay}::date
            ORDER BY mp.member_id, mp.expires_on, mp.id
          ) x
          WHERE x.days_inactive >= ${N}
          ORDER BY x.days_inactive DESC
        `.execute(tx);
        return rows.map((r) => ({
          memberId: r.member_id,
          memberName: r.full_name,
          memberPackageId: r.mp_id,
          idempotencyKey: khoaGoi(r.mp_id),
          payload: { daysInactive: r.days_inactive, remaining: r.remaining },
          detail: `${r.days_inactive} ngày chưa tập, còn ${r.remaining} buổi`,
        }));
      }

      case 'BIRTHDAY': {
        // threshold = gửi trước N ngày. Khoá theo NĂM của lần sinh nhật đó.
        const { rows } = await sql<{ member_id: string; full_name: string; nam: string }>`
          SELECT m.id AS member_id, i.full_name,
                 to_char(${homNay}::date + ${N}::int, 'YYYY') AS nam
          FROM member m
          JOIN identity i ON i.id = m.identity_id
          WHERE m.status = 'ACTIVE' AND m.dob IS NOT NULL
            AND to_char(m.dob, 'MM-DD') = to_char(${homNay}::date + ${N}::int, 'MM-DD')
          ORDER BY i.full_name
        `.execute(tx);
        return rows.map((r) => ({
          memberId: r.member_id,
          memberName: r.full_name,
          memberPackageId: null,
          idempotencyKey: `CAMPAIGN:${c.id}:${r.member_id}:${r.nam}`,
          payload: {},
          detail: N === 0 ? 'Sinh nhật hôm nay' : `Sinh nhật sau ${N} ngày`,
        }));
      }

      case 'PAYMENT_DUE': {
        const { rows } = await sql<{
          schedule_id: string; member_id: string; full_name: string; invoice_code: string;
          amount: string; due_date: string;
        }>`
          SELECT ps.id AS schedule_id, inv.member_id, i.full_name, inv.code AS invoice_code,
                 ps.amount, ps.due_date
          FROM payment_schedule ps
          JOIN invoice inv ON inv.id = ps.invoice_id
          JOIN member m    ON m.id = inv.member_id
          JOIN identity i  ON i.id = m.identity_id
          WHERE ps.status = 'DUE' AND inv.status IN ('OPEN', 'PARTIALLY_PAID')
            AND ps.due_date BETWEEN ${homNay}::date AND ${homNay}::date + ${N}::int
          ORDER BY ps.due_date, ps.id
        `.execute(tx);
        return rows.map((r) => ({
          memberId: r.member_id,
          memberName: r.full_name,
          memberPackageId: null,
          // Một đợt trả góp nhắc MỘT lần.
          idempotencyKey: `CAMPAIGN:${c.id}:${r.schedule_id}`,
          payload: { invoiceCode: r.invoice_code, amount: Number(r.amount), dueDate: r.due_date },
          detail: `${r.invoice_code}: ${new Intl.NumberFormat('vi-VN').format(Number(r.amount))} đ, hạn ${r.due_date}`,
        }));
      }

      default:
        this.log.warn(`Chiến dịch ${c.code}: loại "${c.trigger_type}" chưa được hỗ trợ`);
        return [];
    }
  }
}
