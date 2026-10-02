import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { TenantDb } from '../common/tenant-db.service';

const TZ = 'Asia/Ho_Chi_Minh';

/** Nhắc HLV trước giờ dạy bao nhiêu phút. */
export const NHAC_TRUOC_PHUT = 30;
/** Buổi đã bắt đầu quá bấy nhiêu phút mà chưa điểm danh thì báo lễ tân. */
export const TRE_DIEM_DANH_PHUT = 10;
/** Chỉ báo buổi trễ trong vòng chừng này — worker dừng nửa ngày thì khi chạy lại không xả hàng trăm thông báo cũ. */
const TRE_TOI_DA_PHUT = 120;
/** Lịch dạy trong ngày gửi từ 7h; quá 11h chưa gửi (worker dừng) thì thôi, lúc đó HLV đã dạy được nửa ngày. */
const GIO_LICH_NGAY = { tu: 7, den: 11 };
/** Giữ thông báo bao lâu. */
const GIU_NGAY = 60;

export type KetQuaNhac = { upcoming: number; agenda: number; unchecked: number; purged: number };

/**
 * Sinh thông báo nhắc lịch cho nhân viên của MỘT phòng (tenant lấy từ ngữ cảnh
 * worker). Mỗi loại là một câu INSERT ... SELECT ... ON CONFLICT DO NOTHING
 * theo dedupe_key — chạy bao nhiêu lần, bao nhiêu bản worker cũng không trùng.
 *
 * Người nhận phải còn ACTIVE ở phòng với đúng vai trò: HLV đã nghỉ việc không
 * nhận nhắc, kể cả khi còn sót buổi đứng tên họ.
 */
@Injectable()
export class StaffReminderService {
  constructor(private readonly tdb: TenantDb) {}

  async tick(now = new Date()): Promise<KetQuaNhac> {
    return this.tdb.run(async (tx) => {
      // Khoá theo dedupe gồm cả GIỜ BẮT ĐẦU: buổi bị dời giờ thì nhắc lại theo giờ mới.
      const upcoming = await sql`
        INSERT INTO staff_notification (tenant_id, identity_id, kind, title, body, link, booking_id, dedupe_key)
        SELECT b.tenant_id, t.identity_id, 'PT_UPCOMING',
               'Sắp tới giờ dạy ' || to_char(b.starts_at AT TIME ZONE ${TZ}, 'HH24:MI'),
               mi.full_name || ' (' || m.code || ') · ' || to_char(b.starts_at AT TIME ZONE ${TZ}, 'HH24:MI')
                 || '–' || to_char(b.ends_at AT TIME ZONE ${TZ}, 'HH24:MI'),
               '/schedule/' || b.id, b.id,
               'REMIND:' || b.id || ':' || extract(epoch FROM b.starts_at)::bigint || ':' || t.identity_id
        FROM booking b
        JOIN trainer t   ON t.id = b.trainer_id
        JOIN member m    ON m.id = b.member_id
        JOIN identity mi ON mi.id = m.identity_id
        WHERE b.status = 'BOOKED'
          AND b.starts_at > ${now}::timestamptz
          AND b.starts_at <= ${now}::timestamptz + make_interval(mins => ${NHAC_TRUOC_PHUT})
          AND EXISTS (SELECT 1 FROM tenant_user tu
                      WHERE tu.tenant_id = b.tenant_id AND tu.identity_id = t.identity_id
                        AND tu.role = 'PT' AND tu.status = 'ACTIVE')
        ON CONFLICT ON CONSTRAINT uq_staff_notification_dedupe DO NOTHING
      `.execute(tx);

      const gioVN = Number(
        new Date(now).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false }),
      ) % 24;
      let agenda = 0;
      if (gioVN >= GIO_LICH_NGAY.tu && gioVN < GIO_LICH_NGAY.den) {
        const r = await sql`
          WITH hom_nay AS (SELECT (${now}::timestamptz AT TIME ZONE ${TZ})::date AS d)
          INSERT INTO staff_notification (tenant_id, identity_id, kind, title, body, link, dedupe_key)
          SELECT b.tenant_id, t.identity_id, 'PT_AGENDA',
                 'Hôm nay bạn có ' || count(*) || ' buổi dạy',
                 string_agg(to_char(b.starts_at AT TIME ZONE ${TZ}, 'HH24:MI') || ' ' || mi.full_name, ' · '
                            ORDER BY b.starts_at),
                 '/schedule?view=day&date=' || (SELECT d FROM hom_nay),
                 'AGENDA:' || (SELECT d FROM hom_nay) || ':' || t.identity_id
          FROM booking b
          JOIN trainer t   ON t.id = b.trainer_id
          JOIN member m    ON m.id = b.member_id
          JOIN identity mi ON mi.id = m.identity_id
          WHERE b.status IN ('BOOKED', 'CHECKED_IN', 'COMPLETED')
            AND (b.starts_at AT TIME ZONE ${TZ})::date = (SELECT d FROM hom_nay)
            AND EXISTS (SELECT 1 FROM tenant_user tu
                        WHERE tu.tenant_id = b.tenant_id AND tu.identity_id = t.identity_id
                          AND tu.role = 'PT' AND tu.status = 'ACTIVE')
          GROUP BY b.tenant_id, t.identity_id
          ON CONFLICT ON CONSTRAINT uq_staff_notification_dedupe DO NOTHING
        `.execute(tx);
        agenda = Number(r.numAffectedRows ?? 0);
      }

      // Người nhận buổi trễ: lễ tân; phòng không có lễ tân thì chủ phòng + quản
      // lý (phòng nhỏ chủ tự đứng quầy). Cộng HLV của chính buổi đó.
      const unchecked = await sql`
        WITH tre AS (
          SELECT b.id, b.tenant_id, b.starts_at, b.ends_at, t.identity_id AS pt_identity,
                 mi.full_name AS ten_hv, ti.full_name AS ten_hlv
          FROM booking b
          JOIN trainer t   ON t.id = b.trainer_id
          JOIN identity ti ON ti.id = t.identity_id
          JOIN member m    ON m.id = b.member_id
          JOIN identity mi ON mi.id = m.identity_id
          WHERE b.status = 'BOOKED'
            AND b.starts_at <= ${now}::timestamptz - make_interval(mins => ${TRE_DIEM_DANH_PHUT})
            AND b.starts_at >  ${now}::timestamptz - make_interval(mins => ${TRE_TOI_DA_PHUT})
        ),
        quay AS (
          SELECT tu.identity_id FROM tenant_user tu
          WHERE tu.status = 'ACTIVE'
            AND (tu.role = 'RECEPTION'
                 OR (tu.role IN ('OWNER', 'ADMIN')
                     AND NOT EXISTS (SELECT 1 FROM tenant_user r WHERE r.status = 'ACTIVE' AND r.role = 'RECEPTION')))
        )
        INSERT INTO staff_notification (tenant_id, identity_id, kind, title, body, link, booking_id, dedupe_key)
        SELECT tre.tenant_id, n.identity_id, 'UNCHECKED',
               'Chưa điểm danh: ' || tre.ten_hv,
               'Buổi ' || to_char(tre.starts_at AT TIME ZONE ${TZ}, 'HH24:MI') || '–'
                 || to_char(tre.ends_at AT TIME ZONE ${TZ}, 'HH24:MI') || ' với HLV ' || tre.ten_hlv
                 || ' đã bắt đầu ' || floor(extract(epoch FROM ${now}::timestamptz - tre.starts_at) / 60)::int
                 || ' phút mà chưa điểm danh.',
               '/schedule/' || tre.id, tre.id,
               'UNCHECKED:' || tre.id || ':' || n.identity_id
        FROM tre
        CROSS JOIN LATERAL (
          SELECT identity_id FROM quay
          UNION
          SELECT tre.pt_identity WHERE EXISTS (
            SELECT 1 FROM tenant_user tu
            WHERE tu.identity_id = tre.pt_identity AND tu.role = 'PT' AND tu.status = 'ACTIVE')
        ) n
        ON CONFLICT ON CONSTRAINT uq_staff_notification_dedupe DO NOTHING
      `.execute(tx);

      const purged = await tx
        .deleteFrom('staff_notification')
        .where('created_at', '<', sql<Date>`${now}::timestamptz - make_interval(days => ${GIU_NGAY})`)
        .executeTakeFirst();

      return {
        upcoming: Number(upcoming.numAffectedRows ?? 0),
        agenda,
        unchecked: Number(unchecked.numAffectedRows ?? 0),
        purged: Number(purged.numDeletedRows ?? 0),
      };
    });
  }
}
