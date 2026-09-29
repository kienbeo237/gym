import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  BookingItem,
  BookingStatus,
  CancelBookingRequest,
  CancelBookingResponse,
  CreateBookingRequest,
  ListBookingQuery,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { SessionConsumptionService } from './session-consumption.service';

const TZ = 'Asia/Ho_Chi_Minh';

/** Nhập bù buổi đã tập: cho phép, nhưng không quá xa về quá khứ. */
const BACK_ENTRY_TOI_DA_NGAY = 30;

@Injectable()
export class BookingService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly consumption: SessionConsumptionService,
  ) {}

  async list(q: ListBookingQuery): Promise<BookingItem[]> {
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('booking as b')
        .innerJoin('member as m', 'm.id', 'b.member_id')
        .innerJoin('identity as mi', 'mi.id', 'm.identity_id')
        .innerJoin('trainer as t', 't.id', 'b.trainer_id')
        .innerJoin('identity as ti', 'ti.id', 't.identity_id')
        .innerJoin('member_package as mp', 'mp.id', 'b.member_package_id')
        .select([
          'b.id', 'b.starts_at as startsAt', 'b.ends_at as endsAt', 'b.status',
          'b.checkin_at as checkinAt', 'b.checkin_method as checkinMethod',
          'b.deducted', 'b.cancel_reason as cancelReason', 'b.note',
          'm.id as memberId', 'm.code as memberCode', 'mi.full_name as memberName',
          't.id as trainerId', 'ti.full_name as trainerName',
          'mp.id as memberPackageId', 'mp.code as packageCode',
          'mp.sessions_remaining as sessionsRemaining',
        ])
        // Khoảng ngày do người dùng chọn là ngày trên tờ lịch VIỆT NAM. So thẳng
        // với timestamptz sẽ lệch 7 tiếng ở hai đầu — buổi 6h sáng ngày đầu
        // khoảng và buổi 22h ngày cuối khoảng đều rơi ra ngoài.
        .where(sql<boolean>`(b.starts_at AT TIME ZONE ${TZ})::date >= ${q.from}::date`)
        .where(sql<boolean>`(b.starts_at AT TIME ZONE ${TZ})::date <= ${q.to}::date`)
        .$if(!!q.trainerId, (qb) => qb.where('b.trainer_id', '=', q.trainerId!))
        .$if(!!q.memberId, (qb) => qb.where('b.member_id', '=', q.memberId!))
        .$if(!!q.status, (qb) => qb.where('b.status', '=', q.status!))
        .orderBy('b.starts_at')
        .execute();

      return rows.map((r) => ({
        id: r.id,
        startsAt: new Date(r.startsAt).toISOString(),
        endsAt: new Date(r.endsAt).toISOString(),
        status: r.status as BookingStatus,
        memberId: r.memberId,
        memberName: r.memberName,
        memberCode: r.memberCode,
        trainerId: r.trainerId,
        trainerName: r.trainerName,
        memberPackageId: r.memberPackageId,
        packageCode: r.packageCode,
        sessionsRemaining: r.sessionsRemaining,
        checkinAt: r.checkinAt ? new Date(r.checkinAt).toISOString() : null,
        checkinMethod: r.checkinMethod,
        deducted: r.deducted,
        cancelReason: r.cancelReason,
        note: r.note,
      }));
    });
  }

  async create(dto: CreateBookingRequest): Promise<{ id: string; startsAt: string; endsAt: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      // Khoá hợp đồng: hai người đặt lịch cùng lúc cho cùng một gói sắp hết
      // buổi thì cả hai đều thấy "còn 1 buổi" và cả hai cùng đặt.
      const mp = await this.lockedPackage(tx, dto.memberPackageId);

      if (mp.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Hợp đồng đang ở trạng thái ${mp.status}, không đặt lịch được`,
        });
      }

      const batDau = new Date(dto.startsAt);
      const ketThuc = new Date(batDau.getTime() + dto.durationMinutes * 60_000);
      const ngayTap = batDau.toLocaleDateString('en-CA', { timeZone: TZ });

      if (ngayTap > String(mp.expires_on)) {
        throw new BadRequestException({
          code: 'BOOKING_AFTER_EXPIRY',
          message: `Hợp đồng hết hạn ngày ${String(mp.expires_on)}, không đặt lịch sau ngày đó được`,
        });
      }

      // Đặt lịch KHÔNG trừ buổi — trừ ở lúc điểm danh. Nhưng phải chặn đặt quá
      // số buổi còn lại, tính cả những buổi đã đặt mà chưa diễn ra; nếu không
      // hội viên đặt 10 buổi trong khi chỉ còn 2.
      const daDat = await tx
        .selectFrom('booking')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('member_package_id', '=', dto.memberPackageId)
        .where('status', '=', 'BOOKED')
        .executeTakeFirstOrThrow();

      if (Number(daDat.c) >= mp.sessions_remaining) {
        throw new BadRequestException({
          code: 'NO_SESSION_LEFT',
          message:
            mp.sessions_remaining === 0
              ? 'Hợp đồng đã hết buổi'
              : `Hợp đồng còn ${mp.sessions_remaining} buổi và đã đặt hết ${daDat.c} lịch chưa tập`,
          details: { remaining: mp.sessions_remaining, booked: Number(daDat.c) },
        });
      }

      const trainerId = dto.trainerId ?? mp.trainer_id;
      if (!trainerId) {
        throw new BadRequestException({
          code: 'TRAINER_REQUIRED',
          message: 'Hợp đồng chưa gắn huấn luyện viên, phải chọn người dạy khi đặt lịch',
        });
      }

      const policy = await tx
        .selectFrom('tenant_policy')
        .select('booking_window_days')
        .executeTakeFirstOrThrow();
      const soNgayToi = Math.floor((batDau.getTime() - Date.now()) / 86_400_000);
      if (soNgayToi > policy.booking_window_days) {
        throw new BadRequestException({
          code: 'BOOKING_TOO_FAR',
          message: `Chỉ đặt lịch trước tối đa ${policy.booking_window_days} ngày`,
        });
      }
      // Chặn cả chiều QUÁ KHỨ. Nhập bù buổi đã tập là chuyện thật nên không
      // cấm hẳn, nhưng không giới hạn thì gõ nhầm năm (2025 thay vì 2026) sẽ
      // tạo một buổi cách đây một năm và không gì báo — nó chỉ hiện ra khi ai
      // đó lật lại báo cáo tháng cũ và thấy con số đã đổi.
      if (soNgayToi < -BACK_ENTRY_TOI_DA_NGAY) {
        throw new BadRequestException({
          code: 'BOOKING_TOO_OLD',
          message: `Chỉ nhập bù buổi tập trong vòng ${BACK_ENTRY_TOI_DA_NGAY} ngày trở lại`,
        });
      }

      await this.assertTrongKhungGio(tx, trainerId, batDau, ketThuc);

      try {
        const row = await tx
          .insertInto('booking')
          .values({
            tenant_id: ctx.tenantId,
            member_package_id: dto.memberPackageId,
            member_id: mp.member_id,
            trainer_id: trainerId,
            starts_at: batDau,
            ends_at: ketThuc,
            note: dto.note ?? null,
            created_by: ctx.identityId,
          })
          .returning(['id', 'starts_at', 'ends_at'])
          .executeTakeFirstOrThrow();

        return {
          id: row.id,
          startsAt: new Date(row.starts_at).toISOString(),
          endsAt: new Date(row.ends_at).toISOString(),
        };
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes('excl_booking_trainer_overlap')) {
          throw new BadRequestException({
            code: 'TRAINER_BUSY',
            message: 'Huấn luyện viên đã có buổi khác trùng giờ này',
          });
        }
        if (msg.includes('excl_booking_member_overlap')) {
          throw new BadRequestException({
            code: 'MEMBER_BUSY',
            message: 'Hội viên đã có buổi khác trùng giờ này',
          });
        }
        throw e;
      }
    });
  }

  /**
   * Huỷ buổi tập. Có trừ buổi hay không là do CHÍNH SÁCH, và chính sách được
   * phân giải bằng đúng một hàm ở CSDL (`resolve_booking_policy`) — gói ghi đè
   * phòng, từng ô một.
   */
  async cancel(bookingId: string, dto: CancelBookingRequest): Promise<CancelBookingResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const b = await this.lockedBooking(tx, bookingId);
      if (b.status !== 'BOOKED') {
        throw new BadRequestException({
          code: 'BOOKING_NOT_CANCELLABLE',
          message: `Buổi tập đang ở trạng thái ${b.status}, không huỷ được`,
        });
      }

      // Hội viên chỉ huỷ được buổi của CHÍNH MÌNH. Vai trò MEMBER đã bị chặn ở
      // controller cho đường của nhân viên, nhưng đường tự huỷ thì phải kiểm
      // ở đây — token mang memberId, đường dẫn mang bookingId, hai thứ khác nhau.
      if (ctx.roles.includes('MEMBER') && !ctx.roles.some((r) => r !== 'MEMBER')) {
        if (b.member_id !== ctx.memberId) throw new ForbiddenException('NOT_YOUR_BOOKING');
        if (dto.by !== 'MEMBER') {
          throw new ForbiddenException({
            code: 'CANNOT_CANCEL_AS_STAFF',
            message: 'Hội viên chỉ huỷ được với tư cách của chính mình',
          });
        }
      }

      const pol = await sql<{
        late_cancel_hours: number;
        late_cancel_deducts: boolean;
        no_show_deducts: boolean;
      }>`SELECT * FROM resolve_booking_policy(${ctx.tenantId}::uuid, ${b.template_id}::uuid)`.execute(tx);
      const chinhSach = pol.rows[0]!;

      const gioConLai = (new Date(b.starts_at).getTime() - Date.now()) / 3_600_000;
      const huyMuon = gioConLai < chinhSach.late_cancel_hours;
      const doNhanVien = dto.by !== 'MEMBER';

      // Nhân viên / huấn luyện viên huỷ thì KHÔNG BAO GIỜ trừ buổi của hội viên:
      // lỗi từ phía phòng tập không được tính vào gói của khách.
      const coTru = !doNhanVien && huyMuon && chinhSach.late_cancel_deducts;

      const trangThai: BookingStatus = doNhanVien
        ? dto.by === 'PT'
          ? 'CANCELLED_BY_PT'
          : 'CANCELLED_BY_STAFF'
        : 'CANCELLED_BY_MEMBER';

      await tx
        .updateTable('booking')
        .set({
          status: trangThai,
          cancelled_at: new Date(),
          cancelled_by: ctx.identityId,
          cancel_reason: dto.reason,
          deducted: coTru,
        })
        .where('id', '=', bookingId)
        .execute();

      let conLai = b.sessions_remaining;
      if (coTru) {
        await this.lockedPackage(tx, b.member_package_id);
        const kq = await this.consumption.consume(tx, {
          bookingId,
          memberPackageId: b.member_package_id,
          trainerId: b.trainer_id,
          memberId: b.member_id,
          lyDo: 'LATE_CANCEL',
          xayRaLuc: new Date(),
        });
        conLai = kq.sessionsRemaining;
      }

      const giaiThich = doNhanVien
        ? 'Phòng tập huỷ buổi nên không trừ buổi của hội viên.'
        : coTru
          ? `Huỷ trong vòng ${chinhSach.late_cancel_hours} giờ trước buổi tập nên bị trừ một buổi.`
          : huyMuon
            ? 'Huỷ muộn nhưng gói này không trừ buổi khi huỷ muộn.'
            : `Huỷ trước ${chinhSach.late_cancel_hours} giờ nên không bị trừ buổi.`;

      await this.audit(tx, 'BOOKING_CANCELLED', bookingId, { by: dto.by, deducted: coTru });

      return { status: trangThai, deducted: coTru, explanation: giaiThich, sessionsRemaining: conLai };
    });
  }

  /** Đánh dấu hội viên không đến. Chỉ làm được SAU giờ bắt đầu. */
  async markNoShow(bookingId: string, note?: string): Promise<CancelBookingResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const b = await this.lockedBooking(tx, bookingId);
      if (b.status !== 'BOOKED') {
        throw new BadRequestException({
          code: 'BOOKING_NOT_MARKABLE',
          message: `Buổi tập đang ở trạng thái ${b.status}`,
        });
      }
      if (new Date(b.starts_at).getTime() > Date.now()) {
        throw new BadRequestException({
          code: 'BOOKING_NOT_STARTED',
          message: 'Buổi tập chưa tới giờ, chưa đánh dấu vắng mặt được',
        });
      }

      const pol = await sql<{ no_show_deducts: boolean }>`
        SELECT * FROM resolve_booking_policy(${ctx.tenantId}::uuid, ${b.template_id}::uuid)`.execute(tx);
      const coTru = pol.rows[0]!.no_show_deducts;

      await tx
        .updateTable('booking')
        .set({ status: 'NO_SHOW', deducted: coTru, note: note ?? b.note })
        .where('id', '=', bookingId)
        .execute();

      let conLai = b.sessions_remaining;
      if (coTru) {
        await this.lockedPackage(tx, b.member_package_id);
        const kq = await this.consumption.consume(tx, {
          bookingId,
          memberPackageId: b.member_package_id,
          trainerId: b.trainer_id,
          memberId: b.member_id,
          lyDo: 'NO_SHOW',
          xayRaLuc: new Date(),
        });
        conLai = kq.sessionsRemaining;
      }

      await this.audit(tx, 'BOOKING_NO_SHOW', bookingId, { deducted: coTru });

      return {
        status: 'NO_SHOW',
        deducted: coTru,
        explanation: coTru
          ? 'Vắng mặt không báo trước nên bị trừ một buổi.'
          : 'Gói này không trừ buổi khi vắng mặt.',
        sessionsRemaining: conLai,
      };
    });
  }

  // -------------------------------------------------------------------------

  /**
   * Buổi tập phải nằm trong khung giờ nhận dạy của huấn luyện viên.
   *
   * Huấn luyện viên CHƯA khai khung giờ nào thì cho qua — bắt khai lịch làm
   * việc trước khi nhận được buổi đầu tiên là chặn đúng lúc phòng tập mới bắt
   * đầu dùng hệ thống. Khai rồi thì mới ràng buộc.
   */
  private async assertTrongKhungGio(tx: Tx, trainerId: string, batDau: Date, ketThuc: Date): Promise<void> {
    const co = await tx
      .selectFrom('trainer_availability')
      .select((eb) => eb.fn.countAll<string>().as('c'))
      .where('trainer_id', '=', trainerId)
      .executeTakeFirstOrThrow();
    if (Number(co.c) === 0) return;

    const khop = await sql<{ ok: boolean }>`
      SELECT EXISTS (
        SELECT 1 FROM trainer_availability a
        WHERE a.trainer_id = ${trainerId}::uuid
          AND a.weekday = EXTRACT(DOW FROM ${batDau}::timestamptz AT TIME ZONE ${TZ})::smallint
          AND (${batDau}::timestamptz AT TIME ZONE ${TZ})::time >= a.start_time
          AND (${ketThuc}::timestamptz AT TIME ZONE ${TZ})::time <= a.end_time
      ) AS ok`.execute(tx);

    if (!khop.rows[0]!.ok) {
      throw new BadRequestException({
        code: 'OUTSIDE_AVAILABILITY',
        message: 'Giờ này nằm ngoài khung giờ nhận dạy của huấn luyện viên',
      });
    }
  }

  private async lockedPackage(tx: Tx, id: string) {
    const r = await sql<{
      id: string; member_id: string; trainer_id: string | null; status: string;
      sessions_remaining: number; expires_on: string; template_id: string;
    }>`SELECT id, member_id, trainer_id, status, sessions_remaining, expires_on, template_id
       FROM member_package WHERE id = ${id}::uuid FOR UPDATE`.execute(tx);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('PACKAGE_NOT_FOUND');
    return row;
  }

  private async lockedBooking(tx: Tx, id: string) {
    const r = await sql<{
      id: string; status: string; starts_at: Date; member_id: string; trainer_id: string;
      member_package_id: string; template_id: string; sessions_remaining: number; note: string | null;
    }>`SELECT b.id, b.status, b.starts_at, b.member_id, b.trainer_id, b.member_package_id,
              b.note, mp.template_id, mp.sessions_remaining
       FROM booking b JOIN member_package mp ON mp.id = b.member_package_id
       WHERE b.id = ${id}::uuid FOR UPDATE OF b`.execute(tx);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('BOOKING_NOT_FOUND');
    return row;
  }

  private async audit(tx: Tx, action: string, entityId: string, after: Record<string, unknown>) {
    const ctx = requireContext();
    await tx
      .insertInto('audit_log')
      .values({
        tenant_id: ctx.tenantId,
        actor_id: ctx.identityId,
        action,
        entity: 'booking',
        entity_id: entityId,
        after: JSON.stringify(after),
      })
      .execute();
  }
}
