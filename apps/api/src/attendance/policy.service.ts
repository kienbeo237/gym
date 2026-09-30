import { Injectable } from '@nestjs/common';
import type { BookingPolicy, UpdateBookingPolicy } from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { CUA_SO_THEM_PHUT } from './booking.service';

type Dong = {
  late_cancel_hours: number;
  late_cancel_deducts: boolean;
  no_show_deducts: boolean;
  booking_window_days: number;
  checkin_grace_minutes: number;
  auto_no_show: boolean;
};

const map = (r: Dong): BookingPolicy => ({
  lateCancelHours: r.late_cancel_hours,
  lateCancelDeducts: r.late_cancel_deducts,
  noShowDeducts: r.no_show_deducts,
  bookingWindowDays: r.booking_window_days,
  checkinGraceMinutes: r.checkin_grace_minutes,
  autoNoShow: r.auto_no_show,
  checkinWindowCloseMinutes: r.checkin_grace_minutes + CUA_SO_THEM_PHUT,
});

const COT = [
  'late_cancel_hours', 'late_cancel_deducts', 'no_show_deducts',
  'booking_window_days', 'checkin_grace_minutes', 'auto_no_show',
] as const;

/**
 * Chính sách mặc định của phòng (tenant_policy). Gói tập ghi đè được từng
 * trường — phân giải ở resolve_booking_policy(), không ở đây.
 */
@Injectable()
export class BookingPolicyService {
  constructor(private readonly tdb: TenantDb) {}

  get(): Promise<BookingPolicy> {
    return this.tdb.run(async (tx) => map(await tx.selectFrom('tenant_policy').select(COT).executeTakeFirstOrThrow()));
  }

  update(dto: UpdateBookingPolicy): Promise<BookingPolicy> {
    const ctx = requireContext();
    return this.tdb.run(async (tx) => {
      const truoc = await tx.selectFrom('tenant_policy').select(COT).forUpdate().executeTakeFirstOrThrow();
      const sau = await tx
        .updateTable('tenant_policy')
        .set({
          late_cancel_hours: dto.lateCancelHours,
          late_cancel_deducts: dto.lateCancelDeducts,
          no_show_deducts: dto.noShowDeducts,
          booking_window_days: dto.bookingWindowDays,
          checkin_grace_minutes: dto.checkinGraceMinutes,
          auto_no_show: dto.autoNoShow,
        })
        .where('tenant_id', '=', ctx.tenantId)
        .returning(COT)
        .executeTakeFirstOrThrow();
      // Bật/tắt tự đánh vắng là quyết định về TIỀN của khách: ghi đủ trước/sau.
      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'BOOKING_POLICY_UPDATED',
          entity: 'tenant_policy',
          entity_id: ctx.tenantId,
          before: JSON.stringify(truoc),
          after: JSON.stringify(sau),
        })
        .execute();
      return map(sau);
    });
  }
}
