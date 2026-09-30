import { sql } from 'kysely';
import type { UsageMeter } from '@pt/contracts';
import type { Tx } from '../common/tenant-db.service';

/**
 * Hạn mức TIN ZALO trong tháng theo gói SaaS của phòng (`plan.max_messages_month`).
 *
 * Chỉ đếm kênh ZALO_ZNS: đó là kênh tốn tiền thật (Zalo tính phí từng tin).
 * Tin trong ứng dụng không tốn gì nên không bị giới hạn.
 *
 * Đây là hạn mức MỀM. Số đã dùng được cộng lúc tin chuyển sang SENT, và worker
 * gửi tuần tự trong một phòng — nên một worker không vượt được. Chạy nhiều
 * worker thì có thể lố vài tin ở biên; chấp nhận, vì chặn cứng nghĩa là giữ
 * khoá trên `tenant_message_usage` suốt lúc gọi Zalo.
 *
 * Tháng tính theo giờ Việt Nam, khớp với cách dispatcher cộng `period_month`.
 * Gọi trong TenantDb.run/runAs — RLS giới hạn về đúng phòng đang mở.
 */
export async function hanMucTinThang(tx: Tx): Promise<UsageMeter> {
  const u = await tx
    .selectFrom('tenant_message_usage')
    .select(sql<number>`coalesce(sum(sent_count), 0)::int`.as('n'))
    .where('channel', '=', 'ZALO_ZNS')
    .where('period_month', '=', sql<string>`date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`)
    .executeTakeFirst();
  const p = await tx
    .selectFrom('tenant_subscription as s')
    .innerJoin('plan as p', 'p.code', 's.plan_code')
    .select('p.max_messages_month')
    .executeTakeFirst();
  return { used: Number(u?.n ?? 0), limit: p?.max_messages_month ?? null };
}

export const hetHanMuc = (m: UsageMeter): boolean => m.limit !== null && m.used >= m.limit;

/**
 * Tin OTP KHÔNG bị chặn vì hết hạn mức (vẫn được đếm). Chặn OTP là khoá hội
 * viên khỏi app của chính họ vì một chuyện giữa phòng tập và nền tảng.
 */
export const MIEN_HAN_MUC = new Set(['OTP_LOGIN']);
