import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  AvailableSlots,
  AvailableSlotsQuery,
  BookingItem,
  BookingStatus,
  CancelBookingRequest,
  CancelBookingResponse,
  CreateBookingRequest,
  ListBookingQuery,
  RescheduleBookingRequest,
  RescheduleBookingResponse,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { SessionConsumptionService } from './session-consumption.service';
import { assertChinhMinh, chiLaHoiVien, epPhamViHoiVien } from '../common/member-scope';

const TZ = 'Asia/Ho_Chi_Minh';

/** Nhập bù buổi đã tập: cho phép, nhưng không quá xa về quá khứ. */
const BACK_ENTRY_TOI_DA_NGAY = 30;

/**
 * Cửa sổ điểm danh đóng sau `checkin_grace_minutes + CUA_SO_THEM_PHUT` phút kể
 * từ giờ bắt đầu — khớp phép kiểm CHECKIN_OUT_OF_WINDOW ở CheckinService. Máy
 * chỉ tự đánh vắng SAU mốc này, nên không bao giờ tranh với lễ tân.
 */
export const CUA_SO_THEM_PHUT = 240;

/** Mỗi lượt quét tối đa bấy nhiêu buổi một phòng — phần còn lại để lượt sau. */
const QUET_TOI_DA = 200;

/** Bước gợi ý khung giờ trống. */
const BUOC_GOI_Y_PHUT = 30;
/** HLV chưa khai khung giờ nhận dạy: gợi ý theo giờ mở cửa mặc định. */
const GIO_MO_CUA_MAC_DINH = [{ start: '06:00', end: '21:00' }];
/** Trạng thái chiếm giờ — khớp mệnh đề WHERE của hai ràng buộc EXCLUDE (0002). */
const CHIEM_GIO = ['BOOKED', 'CHECKED_IN', 'COMPLETED'];

const phut = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
/** Ngày (YYYY-MM-DD, giờ VN) + phút trong ngày -> thời điểm UTC. VN cố định UTC+7, không đổi giờ mùa hè. */
const thoiDiemVN = (ngay: string, phutTrongNgay: number) =>
  new Date(Date.parse(`${ngay}T00:00:00+07:00`) + phutTrongNgay * 60_000);
const congNgay = (ngay: string, n: number) =>
  new Date(Date.parse(`${ngay}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

type BuoiKhoa = Awaited<ReturnType<BookingService['lockedBooking']>>;

@Injectable()
export class BookingService {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly consumption: SessionConsumptionService,
  ) {}

  async list(q: ListBookingQuery): Promise<BookingItem[]> {
    // RLS cách ly giữa các PHÒNG TẬP, không cách ly giữa các HỘI VIÊN trong
    // cùng phòng. Đo 29/09/2026 trước khi vá: một hội viên gọi endpoint này
    // nhận về 13 buổi tập kèm HỌ TÊN, MÃ HỢP ĐỒNG và SỐ BUỔI CÒN LẠI của hai
    // người khác. Nhân viên thì vẫn nhìn cả phòng.
    const memberId = epPhamViHoiVien(q.memberId);
    return this.tdb.run((tx) => this.docBuoi(tx, { list: q, memberId }));
  }

  /** Một buổi. Hội viên hỏi buổi của người khác: 404 — không xác nhận id tồn tại. */
  async get(id: string): Promise<BookingItem> {
    const memberId = epPhamViHoiVien();
    const [b] = await this.tdb.run((tx) => this.docBuoi(tx, { id, memberId }));
    if (!b) throw new NotFoundException('BOOKING_NOT_FOUND');
    return b;
  }

  private async docBuoi(
    tx: Tx,
    loc: { list?: ListBookingQuery; id?: string; memberId?: string },
  ): Promise<BookingItem[]> {
    const q = loc.list;
    const memberId = loc.memberId;
    const rows = await tx
      .selectFrom('booking as b')
      .innerJoin('member as m', 'm.id', 'b.member_id')
      .innerJoin('identity as mi', 'mi.id', 'm.identity_id')
      .innerJoin('trainer as t', 't.id', 'b.trainer_id')
      .innerJoin('identity as ti', 'ti.id', 't.identity_id')
      .innerJoin('member_package as mp', 'mp.id', 'b.member_package_id')
      .select([
        'b.id', 'b.starts_at as startsAt', 'b.ends_at as endsAt', 'b.status',
        'b.checkin_at as checkinAt', 'b.checkin_method as checkinMethod', 'b.checkin_note as checkinNote',
        'b.deducted', 'b.cancel_reason as cancelReason', 'b.note',
        'm.id as memberId', 'm.code as memberCode', 'mi.full_name as memberName',
        't.id as trainerId', 'ti.full_name as trainerName',
        'mp.id as memberPackageId', 'mp.code as packageCode',
        'mp.sessions_remaining as sessionsRemaining',
        sql<number>`(SELECT late_cancel_hours FROM resolve_booking_policy(b.tenant_id, mp.template_id))`.as('lateCancelHours'),
      ])
      // Khoảng ngày do người dùng chọn là ngày trên tờ lịch VIỆT NAM. So thẳng
      // với timestamptz sẽ lệch 7 tiếng ở hai đầu — buổi 6h sáng ngày đầu
      // khoảng và buổi 22h ngày cuối khoảng đều rơi ra ngoài.
      .$if(!!q, (qb) =>
        qb
          .where(sql<boolean>`(b.starts_at AT TIME ZONE ${TZ})::date >= ${q!.from}::date`)
          .where(sql<boolean>`(b.starts_at AT TIME ZONE ${TZ})::date <= ${q!.to}::date`),
      )
      .$if(!!loc.id, (qb) => qb.where('b.id', '=', loc.id!))
      .$if(!!q?.trainerId, (qb) => qb.where('b.trainer_id', '=', q!.trainerId!))
      .$if(!!memberId, (qb) => qb.where('b.member_id', '=', memberId!))
      .$if(!!q?.status, (qb) => qb.where('b.status', '=', q!.status!))
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
      checkinNote: r.checkinNote,
      deducted: r.deducted,
      cancelReason: r.cancelReason,
      lateCancelHours: r.lateCancelHours,
      note: r.note,
    }));
  }

  async create(dto: CreateBookingRequest): Promise<{ id: string; startsAt: string; endsAt: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      // Khoá hợp đồng: hai người đặt lịch cùng lúc cho cùng một gói sắp hết
      // buổi thì cả hai đều thấy "còn 1 buổi" và cả hai cùng đặt.
      const mp = await this.lockedPackage(tx, dto.memberPackageId);

      // Đo 29/09/2026 trước khi vá: hội viên A gửi memberPackageId của hội viên
      // B và đặt được buổi TRÊN GÓI CỦA B — buổi đó sau này trừ vào tiền của B.
      // RLS không chặn (cùng phòng); controller không chặn (MEMBER được đặt lịch).
      assertChinhMinh(mp.member_id);
      const laHoiVien = chiLaHoiVien(ctx);

      if (mp.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Hợp đồng đang ở trạng thái ${mp.status}, không đặt lịch được`,
        });
      }

      const batDau = new Date(dto.startsAt);
      const ketThuc = new Date(batDau.getTime() + dto.durationMinutes * 60_000);

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

      const trainerId = this.nguoiDay(mp, dto.trainerId, laHoiVien);
      await this.kiemGio(tx, mp, trainerId, batDau, ketThuc, laHoiVien);

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
        loiTrungGio(e);
      }
    });
  }

  /**
   * Khung giờ còn trống của người dạy hợp đồng, theo từng ngày. Cùng các ràng
   * buộc với create() — khung nhận dạy, hạn hợp đồng, cửa sổ đặt trước, trùng
   * giờ PT / hội viên — nên giờ được gợi ý thì đặt được (trừ khi có người
   * nhanh tay hơn; EXCLUDE ở CSDL vẫn là chốt chặn cuối).
   */
  async slots(q: AvailableSlotsQuery): Promise<AvailableSlots> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const mp = await tx
        .selectFrom('member_package')
        .select(['id', 'member_id', 'trainer_id', 'status', 'sessions_remaining', 'expires_on'])
        .where('id', '=', q.memberPackageId)
        .executeTakeFirst();
      if (!mp) throw new NotFoundException('PACKAGE_NOT_FOUND');
      assertChinhMinh(mp.member_id);
      if (mp.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Hợp đồng đang ở trạng thái ${mp.status}, không đặt lịch được`,
        });
      }
      const trainerId = this.nguoiDay(mp, q.trainerId, chiLaHoiVien(ctx));

      const pt = await tx
        .selectFrom('trainer as t')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .select(['i.full_name as name', 't.status'])
        .where('t.id', '=', trainerId)
        .executeTakeFirst();
      if (!pt) throw new NotFoundException('TRAINER_NOT_FOUND');

      const khung = await tx
        .selectFrom('trainer_availability')
        .select(['weekday', 'start_time', 'end_time'])
        .where('trainer_id', '=', trainerId)
        .execute();
      const pol = await tx.selectFrom('tenant_policy').select('booking_window_days').executeTakeFirstOrThrow();
      const daDat = await tx
        .selectFrom('booking')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('member_package_id', '=', mp.id)
        .where('status', '=', 'BOOKED')
        .executeTakeFirstOrThrow();

      const dau = thoiDiemVN(q.from, 0);
      const cuoi = thoiDiemVN(congNgay(q.from, q.days), 0);
      const ban = await tx
        .selectFrom('booking')
        .select(['starts_at', 'ends_at'])
        .where('status', 'in', CHIEM_GIO)
        .where((eb) => eb.or([eb('trainer_id', '=', trainerId), eb('member_id', '=', mp.member_id)]))
        .where('starts_at', '<', cuoi)
        .where('ends_at', '>', dau)
        .execute();
      const banMs = ban.map((b) => [new Date(b.starts_at).getTime(), new Date(b.ends_at).getTime()] as const);

      const bayGio = Date.now();
      const hanDat = bayGio + (pol.booking_window_days + 1) * 86_400_000;
      const hetHan = String(mp.expires_on);
      const dur = q.durationMinutes;

      const days: AvailableSlots['days'] = [];
      for (let i = 0; i < q.days; i++) {
        const ngay = congNgay(q.from, i);
        const slots: { startsAt: string; endsAt: string }[] = [];
        if (ngay <= hetHan && pt.status === 'ACTIVE') {
          const thu = new Date(`${ngay}T00:00:00Z`).getUTCDay();
          const cuaSo = khung.length
            ? khung.filter((k) => k.weekday === thu).map((k) => ({ start: String(k.start_time), end: String(k.end_time) }))
            : GIO_MO_CUA_MAC_DINH;
          for (const w of cuaSo) {
            for (let m = phut(w.start); m + dur <= phut(w.end); m += BUOC_GOI_Y_PHUT) {
              const s = thoiDiemVN(ngay, m).getTime();
              const e = s + dur * 60_000;
              if (s <= bayGio || s > hanDat) continue;
              if (Math.floor((s - bayGio) / 86_400_000) > pol.booking_window_days) continue;
              if (banMs.some(([bs, be]) => s < be && e > bs)) continue;
              slots.push({ startsAt: new Date(s).toISOString(), endsAt: new Date(e).toISOString() });
            }
          }
        }
        slots.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        days.push({ date: ngay, slots });
      }

      return {
        trainerId,
        trainerName: pt.name,
        durationMinutes: dur,
        hasAvailability: khung.length > 0,
        bookableSessions: Math.max(0, mp.sessions_remaining - Number(daDat.c)),
        days,
      };
    });
  }

  /**
   * Đổi giờ một buổi đang chờ — GIỮ NGUYÊN buổi, không huỷ + đặt lại. Trước
   * khi có thao tác này, người dùng phải huỷ rồi đặt lại, và huỷ trong khung
   * huỷ muộn thì bị trừ buổi dù ý định chỉ là dời giờ.
   *
   * Hội viên tự đổi chỉ khi còn NGOÀI khung huỷ muộn của giờ cũ — trong khung
   * đó, "đổi lịch" chính là cách lách phí huỷ muộn. Nhân viên đổi lúc nào cũng
   * được (lỗi / thay đổi từ phía phòng tập không tính vào gói của khách).
   */
  async reschedule(bookingId: string, dto: RescheduleBookingRequest): Promise<RescheduleBookingResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const b = await this.lockedBooking(tx, bookingId);
      assertChinhMinh(b.member_id);
      if (b.status !== 'BOOKED') {
        throw new BadRequestException({
          code: 'BOOKING_NOT_RESCHEDULABLE',
          message: `Buổi tập đang ở trạng thái ${b.status}, không đổi lịch được`,
        });
      }
      const laHoiVien = chiLaHoiVien(ctx);

      if (laHoiVien) {
        const pol = await sql<{ late_cancel_hours: number }>`
          SELECT late_cancel_hours FROM resolve_booking_policy(${ctx.tenantId}::uuid, ${b.template_id}::uuid)`.execute(tx);
        const gio = pol.rows[0]!.late_cancel_hours;
        if ((new Date(b.starts_at).getTime() - Date.now()) / 3_600_000 < gio) {
          throw new BadRequestException({
            code: 'RESCHEDULE_TOO_LATE',
            message: `Chỉ tự đổi lịch được trước giờ tập ${gio} tiếng. Liên hệ phòng tập để được hỗ trợ.`,
          });
        }
      }

      const mp = await this.lockedPackage(tx, b.member_package_id);
      if (mp.status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Hợp đồng đang ở trạng thái ${mp.status}, không đổi lịch được`,
        });
      }

      const cuBatDau = new Date(b.starts_at);
      const cuKetThuc = new Date(b.ends_at);
      const dur = dto.durationMinutes ?? Math.round((cuKetThuc.getTime() - cuBatDau.getTime()) / 60_000);
      const batDau = new Date(dto.startsAt);
      const ketThuc = new Date(batDau.getTime() + dur * 60_000);
      if (batDau.getTime() === cuBatDau.getTime() && ketThuc.getTime() === cuKetThuc.getTime()) {
        return { id: b.id, startsAt: cuBatDau.toISOString(), endsAt: cuKetThuc.toISOString() };
      }

      await this.kiemGio(tx, mp, b.trainer_id, batDau, ketThuc, laHoiVien);

      try {
        await tx
          .updateTable('booking')
          .set({ starts_at: batDau, ends_at: ketThuc })
          .where('id', '=', b.id)
          .execute();
      } catch (e) {
        loiTrungGio(e);
      }

      await this.audit(tx, 'BOOKING_RESCHEDULED', b.id, {
        from: { startsAt: cuBatDau.toISOString(), endsAt: cuKetThuc.toISOString() },
        to: { startsAt: batDau.toISOString(), endsAt: ketThuc.toISOString() },
        by: laHoiVien ? 'MEMBER' : 'STAFF',
        ...(dto.reason ? { reason: dto.reason } : {}),
      });
      return { id: b.id, startsAt: batDau.toISOString(), endsAt: ketThuc.toISOString() };
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
      //
      // Dùng `chiLaHoiVien` thay vì tự viết lại điều kiện: bản cũ ở đây là
      // `!roles.some(r => r !== 'MEMBER')` ("không có vai trò nào khác"), còn
      // helper hỏi "không có vai trò NHÂN VIÊN nào". Hai câu này trùng nhau với
      // 5 vai trò hiện có nhưng sẽ tách ra ngay khi thêm vai trò thứ sáu — và
      // khi tách thì không gì báo.
      if (chiLaHoiVien(ctx)) {
        assertChinhMinh(b.member_id);
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
      return this.danhVang(tx, b, note ?? b.note, false);
    });
  }

  /**
   * Lượt quét của worker cho MỘT phòng (chạy trong ngữ cảnh chỉ có tenant):
   *
   *  1. Buổi đã điểm danh và đã qua giờ kết thúc -> COMPLETED. Không đụng tiền
   *     (buổi đã trừ lúc điểm danh), nên luôn bật.
   *  2. Buổi vẫn BOOKED khi cửa sổ điểm danh đã đóng -> NO_SHOW, CHỈ KHI phòng
   *     bật `auto_no_show`. Đây là thao tác trừ tiền của khách.
   *
   * An toàn khi chạy lặp và chạy song song với thao tác tay: mỗi buổi được
   * khoá và kiểm lại trạng thái trong transaction riêng của nó.
   */
  async sweep(now = new Date()): Promise<{ completed: number; noShow: number; failed: number }> {
    const completed = await this.tdb.run(async (tx) => {
      const rows = await tx
        .updateTable('booking')
        .set({ status: 'COMPLETED' })
        .where('status', '=', 'CHECKED_IN')
        .where('ends_at', '<', now)
        .returning('id')
        .execute();
      if (rows.length > 0) {
        await this.audit(tx, 'BOOKING_AUTO_COMPLETED', null, { count: rows.length, ids: rows.slice(0, 50).map((r) => r.id) });
      }
      return rows.length;
    });

    const pol = await this.tdb.run((tx) =>
      tx.selectFrom('tenant_policy').select(['auto_no_show', 'checkin_grace_minutes']).executeTakeFirst(),
    );
    if (!pol?.auto_no_show) return { completed, noShow: 0, failed: 0 };

    const han = new Date(now.getTime() - (pol.checkin_grace_minutes + CUA_SO_THEM_PHUT) * 60_000);
    const ds = await this.tdb.run((tx) =>
      tx
        .selectFrom('booking')
        .select('id')
        .where('status', '=', 'BOOKED')
        .where('starts_at', '<', han)
        .orderBy('starts_at')
        .limit(QUET_TOI_DA)
        .execute(),
    );

    let noShow = 0;
    let failed = 0;
    for (const { id } of ds) {
      try {
        const lam = await this.tdb.run(async (tx) => {
          const b = await this.lockedBooking(tx, id);
          if (b.status !== 'BOOKED') return false; // lễ tân vừa xử lý tay
          await this.danhVang(tx, b, b.note, true);
          return true;
        });
        if (lam) noShow++;
      } catch (e) {
        // Một buổi lỗi không được chặn cả lô; lượt sau thử lại.
        failed++;
        this.log.error(`Tự đánh vắng buổi ${id} lỗi: ${String(e)}`);
      }
    }
    return { completed, noShow, failed };
  }

  /**
   * Lõi đánh vắng — dùng chung cho thao tác tay và job tự động. Bên gọi đã
   * khoá buổi và kiểm trạng thái BOOKED.
   *
   * Đường TỰ ĐỘNG không trừ buổi khi hợp đồng không còn trừ được (hết buổi,
   * không còn ACTIVE): máy không tự quyết một khoản nợ. Buổi vẫn ghi NO_SHOW
   * để lịch sạch, và nhật ký ghi rõ vì sao không trừ.
   */
  private async danhVang(tx: Tx, b: BuoiKhoa, note: string | null, tuDong: boolean): Promise<CancelBookingResponse> {
    const ctx = requireContext();
    const pol = await sql<{ no_show_deducts: boolean }>`
      SELECT * FROM resolve_booking_policy(${ctx.tenantId}::uuid, ${b.template_id}::uuid)`.execute(tx);
    const theoChinhSach = pol.rows[0]!.no_show_deducts;
    const truDuoc = b.package_status === 'ACTIVE' && b.sessions_remaining > 0;
    const coTru = theoChinhSach && (!tuDong || truDuoc);

    await tx
      .updateTable('booking')
      .set({ status: 'NO_SHOW', deducted: coTru, note })
      .where('id', '=', b.id)
      .execute();

    let conLai = b.sessions_remaining;
    if (coTru) {
      await this.lockedPackage(tx, b.member_package_id);
      const kq = await this.consumption.consume(tx, {
        bookingId: b.id,
        memberPackageId: b.member_package_id,
        trainerId: b.trainer_id,
        memberId: b.member_id,
        lyDo: 'NO_SHOW',
        xayRaLuc: new Date(),
      });
      conLai = kq.sessionsRemaining;
    }

    await this.audit(tx, 'BOOKING_NO_SHOW', b.id, {
      deducted: coTru,
      ...(tuDong ? { auto: true } : {}),
      ...(tuDong && theoChinhSach && !coTru ? { skippedDeduction: 'PACKAGE_NOT_DEDUCTIBLE' } : {}),
    });

    return {
      status: 'NO_SHOW',
      deducted: coTru,
      explanation: coTru
        ? 'Vắng mặt không báo trước nên bị trừ một buổi.'
        : theoChinhSach
          ? 'Hợp đồng không còn buổi để trừ — ghi vắng mặt, không trừ.'
          : 'Gói này không trừ buổi khi vắng mặt.',
      sessionsRemaining: conLai,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Người dạy buổi. Hội viên KHÔNG chọn được người khác người phụ trách hợp
   * đồng — đổi PT là việc phòng tập quyết (lương, hoa hồng dạy của hai người).
   */
  private nguoiDay(mp: { trainer_id: string | null }, yeuCau: string | undefined, laHoiVien: boolean): string {
    if (laHoiVien && yeuCau && yeuCau !== mp.trainer_id) {
      throw new ForbiddenException({
        code: 'TRAINER_NOT_ALLOWED',
        message: 'Hội viên chỉ đặt được với huấn luyện viên phụ trách gói',
      });
    }
    const id = (laHoiVien ? null : yeuCau) ?? mp.trainer_id;
    if (!id) {
      throw new BadRequestException({
        code: 'TRAINER_REQUIRED',
        message: 'Hợp đồng chưa gắn huấn luyện viên, phải chọn người dạy khi đặt lịch',
      });
    }
    return id;
  }

  /**
   * Mọi ràng buộc THỜI GIAN của một buổi, dùng chung cho đặt mới và đổi lịch
   * — viết hai lần là hai chỗ để chúng trôi khỏi nhau.
   */
  private async kiemGio(
    tx: Tx,
    mp: { expires_on: string },
    trainerId: string,
    batDau: Date,
    ketThuc: Date,
    laHoiVien: boolean,
  ): Promise<void> {
    const ngayTap = batDau.toLocaleDateString('en-CA', { timeZone: TZ });
    if (ngayTap > String(mp.expires_on)) {
      throw new BadRequestException({
        code: 'BOOKING_AFTER_EXPIRY',
        message: `Hợp đồng hết hạn ngày ${String(mp.expires_on)}, không đặt lịch sau ngày đó được`,
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
    // Hội viên không nhập bù: buổi đã qua là việc của lễ tân / PT.
    if (laHoiVien && batDau.getTime() <= Date.now()) {
      throw new BadRequestException({
        code: 'BOOKING_IN_PAST',
        message: 'Không đặt được buổi tập ở thời điểm đã qua',
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
  }

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
      id: string; status: string; starts_at: Date; ends_at: Date; member_id: string; trainer_id: string;
      member_package_id: string; template_id: string; sessions_remaining: number; note: string | null;
      package_status: string;
    }>`SELECT b.id, b.status, b.starts_at, b.ends_at, b.member_id, b.trainer_id, b.member_package_id,
              b.note, mp.template_id, mp.sessions_remaining, mp.status AS package_status
       FROM booking b JOIN member_package mp ON mp.id = b.member_package_id
       WHERE b.id = ${id}::uuid FOR UPDATE OF b`.execute(tx);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('BOOKING_NOT_FOUND');
    return row;
  }

  private async audit(tx: Tx, action: string, entityId: string | null, after: Record<string, unknown>) {
    const ctx = requireContext();
    await tx
      .insertInto('audit_log')
      .values({
        tenant_id: ctx.tenantId,
        // Worker chạy với identityId rỗng: người thực hiện là HỆ THỐNG (NULL).
        actor_id: ctx.identityId || null,
        action,
        entity: 'booking',
        entity_id: entityId,
        after: JSON.stringify(after),
      })
      .execute();
  }
}

/** Dịch vi phạm hai ràng buộc EXCLUDE thành lỗi người dùng đọc được; lỗi khác ném nguyên. */
function loiTrungGio(e: unknown): never {
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
