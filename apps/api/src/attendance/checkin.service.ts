import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { sql } from 'kysely';
import type { CheckinRequest, CheckinResponse, CheckinTokenResponse } from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { SessionConsumptionService } from './session-consumption.service';
import { chiLaHoiVien } from '../common/member-scope';

/** Mã QR sống 60 giây. Đủ để quét, không đủ để chụp màn hình gửi cho nhau. */
const TOKEN_TTL_GIAY = 60;
const CANH_BAO_SAP_HET = 3;

@Injectable()
export class CheckinService {
  constructor(
    private readonly tdb: TenantDb,
    private readonly consumption: SessionConsumptionService,
  ) {}

  private hash(v: string): string {
    return createHash('sha256').update(v).digest('hex');
  }

  /**
   * Huấn luyện viên mở buổi tập -> sinh mã QR.
   *
   * Vì sao cần mã thay vì để huấn luyện viên tự bấm "đã tập": người bấm điểm
   * danh cũng là người ăn hoa hồng dạy. Tự xác nhận là bỏ mất chốt kiểm soát —
   * trừ buổi của khách mà không dạy thì không ai biết. Mã QR buộc hội viên phải
   * có mặt và thao tác.
   *
   * Mã cũ chưa dùng bị vô hiệu khi sinh mã mới (`uq_checkin_token_open` chỉ cho
   * một mã đang mở trên mỗi buổi).
   */
  async issueToken(bookingId: string): Promise<CheckinTokenResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const b = await tx
        .selectFrom('booking')
        .select(['id', 'status', 'trainer_id', 'starts_at'])
        .where('id', '=', bookingId)
        .executeTakeFirst();
      if (!b) throw new NotFoundException('BOOKING_NOT_FOUND');
      if (b.status !== 'BOOKED') {
        throw new BadRequestException({
          code: 'BOOKING_NOT_CHECKINABLE',
          message: `Buổi tập đang ở trạng thái ${b.status}`,
        });
      }
      // Huấn luyện viên chỉ mở được buổi của chính mình; quản lý thì mở được mọi buổi.
      const laNhanVien = ctx.roles.some((r) => r === 'OWNER' || r === 'ADMIN' || r === 'RECEPTION');
      if (!laNhanVien && ctx.trainerId !== b.trainer_id) {
        throw new ForbiddenException('NOT_YOUR_BOOKING');
      }

      const token = randomBytes(24).toString('base64url');

      // Đóng mã cũ trước khi mở mã mới, không thì vỡ ở uq_checkin_token_open.
      await tx
        .updateTable('checkin_token')
        .set({ used_at: new Date() })
        .where('booking_id', '=', bookingId)
        .where('used_at', 'is', null)
        .execute();

      await tx
        .insertInto('checkin_token')
        .values({
          tenant_id: ctx.tenantId,
          booking_id: bookingId,
          token_hash: this.hash(token),
          expires_at: new Date(Date.now() + TOKEN_TTL_GIAY * 1000),
        })
        .execute();

      return { token, expiresInSeconds: TOKEN_TTL_GIAY, bookingId };
    });
  }

  /**
   * Điểm danh. Giao dịch chạm tiền nhiều nhất trong hệ thống.
   *
   * Thứ tự KHÔNG đổi được:
   *   1. khoá HỢP ĐỒNG (không phải khoá buổi tập) — hai thiết bị bấm cùng lúc
   *      cho hai buổi KHÁC NHAU của cùng một gói sắp hết buổi thì cả hai đều
   *      thấy "còn 1 buổi"
   *   2. kiểm mọi điều kiện
   *   3. đổi trạng thái buổi tập
   *   4. tiêu thụ buổi -> sổ cái, doanh thu, hoa hồng, hộp thư đi
   *
   * Idempotent: bấm hai lần trả về cùng kết quả thay vì trừ hai buổi. Lớp chặn
   * cuối là `uq_ledger_checkin` ở CSDL, không phải phép kiểm ở đây.
   */
  async checkIn(bookingId: string, dto: CheckinRequest): Promise<CheckinResponse> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      const b = await this.lockedForCheckin(tx, bookingId);

      // Hội viên chỉ điểm danh cho CHÍNH MÌNH.
      //
      // Phải đứng TRƯỚC nhánh trả về idempotent bên dưới, không phải sau. Đo
      // 29/09/2026 với phép kiểm đặt sau: hội viên B quét mã của buổi thuộc
      // hội viên A, buổi đã điểm danh xong nên rơi vào nhánh idempotent và B
      // nhận về SỐ BUỔI CÒN LẠI và NGÀY HẾT HẠN của A. Không trừ nhầm buổi,
      // nhưng vẫn là rò dữ liệu — và lỗi trông "đúng" vì trả về 201.
      //
      // Mã QR chứng minh "huấn luyện viên đã mở buổi tập này"; nó KHÔNG chứng
      // minh "đúng người đang xác nhận". Thiếu phép kiểm này thì ai đứng cạnh
      // màn hình cũng quét được mã của người khác.
      if (chiLaHoiVien(ctx) && ctx.memberId !== b.member_id) {
        throw new ForbiddenException('NOT_YOUR_BOOKING');
      }

      if (b.status === 'CHECKED_IN' || b.status === 'COMPLETED') {
        // Đã điểm danh rồi — trả kết quả cũ, không ném lỗi. Người dùng bấm hai
        // lần vì mạng chậm, không phải vì làm sai.
        return this.ketQuaDaCo(tx, bookingId, b.member_package_id);
      }
      if (b.status !== 'BOOKED') {
        throw new BadRequestException({
          code: 'BOOKING_NOT_CHECKINABLE',
          message: `Buổi tập đang ở trạng thái ${b.status}`,
        });
      }

      if (dto.method === 'QR') {
        await this.assertToken(tx, bookingId, dto.token);
      } else if (dto.method === 'PT_CONFIRM' || dto.method === 'ADMIN') {
        // Đường không có mã QR. Vẫn cho phép (mất điện thoại, hỏng camera),
        // nhưng `checkin_by` được ghi lại và hội viên nhận thông báo ngay —
        // đó là cơ chế đối soát thay cho mã QR.
        const laNhanVien = ctx.roles.some((r) => r === 'OWNER' || r === 'ADMIN' || r === 'RECEPTION');
        if (!laNhanVien && ctx.trainerId !== b.trainer_id) {
          throw new ForbiddenException('NOT_YOUR_BOOKING');
        }
      }
      // Nhánh MEMBER_CONFIRM không cần kiểm riêng nữa: phép kiểm ở trên đã bao.

      // --- điều kiện của hợp đồng ------------------------------------------
      if (b.package_status !== 'ACTIVE') {
        throw new BadRequestException({
          code: 'PACKAGE_NOT_ACTIVE',
          message: `Hợp đồng đang ở trạng thái ${b.package_status}`,
        });
      }
      const homNay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      if (homNay > String(b.expires_on)) {
        throw new BadRequestException({
          code: 'PACKAGE_EXPIRED',
          message: `Hợp đồng đã hết hạn ngày ${String(b.expires_on)}`,
        });
      }
      if (b.sessions_remaining <= 0) {
        throw new BadRequestException({
          code: 'NO_SESSION_LEFT',
          message: 'Hợp đồng đã hết buổi tập',
        });
      }

      // Chống điểm danh cho buổi của ngày mai. `checkin_grace_minutes` cho phép
      // điểm danh sớm/muộn quanh giờ hẹn.
      const pol = await tx
        .selectFrom('tenant_policy')
        .select('checkin_grace_minutes')
        .executeTakeFirstOrThrow();
      const lechPhut = Math.abs(new Date(b.starts_at).getTime() - Date.now()) / 60_000;
      if (lechPhut > pol.checkin_grace_minutes + 240) {
        throw new BadRequestException({
          code: 'CHECKIN_OUT_OF_WINDOW',
          message: 'Thời điểm điểm danh cách quá xa giờ hẹn của buổi tập',
        });
      }

      const luc = new Date();
      await tx
        .updateTable('booking')
        .set({
          status: 'CHECKED_IN',
          checkin_at: luc,
          checkin_method: dto.method,
          checkin_by: ctx.identityId,
          deducted: true,
        })
        .where('id', '=', bookingId)
        .execute();

      const kq = await this.consumption.consume(tx, {
        bookingId,
        memberPackageId: b.member_package_id,
        trainerId: b.trainer_id,
        memberId: b.member_id,
        lyDo: 'CHECKIN',
        xayRaLuc: luc,
      });

      return {
        bookingId,
        status: 'CHECKED_IN',
        sessionsRemaining: kq.sessionsRemaining,
        sessionsTotal: kq.sessionsTotal,
        revenueRecognized: kq.revenueRecognized,
        teachCommission: kq.teachCommission,
        lowBalanceWarning: kq.sessionsRemaining <= CANH_BAO_SAP_HET,
        expiresOn: String(b.expires_on),
      };
    });
  }

  // -------------------------------------------------------------------------

  private async assertToken(tx: Tx, bookingId: string, token: string | undefined): Promise<void> {
    if (!token) {
      throw new BadRequestException({ code: 'CHECKIN_TOKEN_REQUIRED', message: 'Thiếu mã điểm danh' });
    }
    const row = await tx
      .selectFrom('checkin_token')
      .select(['id', 'token_hash', 'expires_at'])
      .where('booking_id', '=', bookingId)
      .where('used_at', 'is', null)
      .executeTakeFirst();

    const sai = () =>
      new BadRequestException({
        code: 'CHECKIN_TOKEN_INVALID',
        message: 'Mã điểm danh không đúng hoặc đã hết hạn',
      });

    if (!row) throw sai();
    if (new Date(row.expires_at).getTime() < Date.now()) throw sai();

    // So sánh thời gian hằng, như mọi chỗ khác so bí mật trong hệ thống này.
    const a = Buffer.from(this.hash(token), 'hex');
    const c = Buffer.from(row.token_hash, 'hex');
    if (a.length !== c.length || !timingSafeEqual(a, c)) throw sai();

    await tx
      .updateTable('checkin_token')
      .set({ used_at: new Date() })
      .where('id', '=', row.id)
      .execute();
  }

  /** Trả lại kết quả của lần điểm danh trước, cho lời gọi lặp. */
  private async ketQuaDaCo(tx: Tx, bookingId: string, packageId: string): Promise<CheckinResponse> {
    const [re, ce, mp] = await Promise.all([
      tx.selectFrom('revenue_entry').select('amount').where('booking_id', '=', bookingId).executeTakeFirst(),
      tx
        .selectFrom('commission_entry')
        .select('amount')
        .where('booking_id', '=', bookingId)
        .where('kind', '=', 'TEACH')
        .executeTakeFirst(),
      tx
        .selectFrom('member_package')
        .select(['sessions_remaining', 'sessions_total', 'expires_on'])
        .where('id', '=', packageId)
        .executeTakeFirstOrThrow(),
    ]);

    return {
      bookingId,
      status: 'CHECKED_IN',
      sessionsRemaining: mp.sessions_remaining,
      sessionsTotal: mp.sessions_total,
      revenueRecognized: Number(re?.amount ?? 0),
      teachCommission: Number(ce?.amount ?? 0),
      lowBalanceWarning: mp.sessions_remaining <= CANH_BAO_SAP_HET,
      expiresOn: String(mp.expires_on),
    };
  }

  /**
   * Khoá HỢP ĐỒNG, không khoá buổi tập.
   *
   * Khoá buổi tập chỉ chặn hai lần bấm cho CÙNG một buổi; `uq_ledger_checkin`
   * đã lo ca đó. Cái cần chặn là hai buổi KHÁC NHAU của cùng một gói còn đúng
   * một buổi — cả hai cùng đọc "còn 1" rồi cùng trừ.
   */
  private async lockedForCheckin(tx: Tx, bookingId: string) {
    const r = await sql<{
      status: string; member_id: string; trainer_id: string; member_package_id: string;
      starts_at: Date; package_status: string; sessions_remaining: number; expires_on: string;
    }>`SELECT b.status, b.member_id, b.trainer_id, b.member_package_id, b.starts_at,
              mp.status AS package_status, mp.sessions_remaining, mp.expires_on
       FROM booking b
       JOIN member_package mp ON mp.id = b.member_package_id
       WHERE b.id = ${bookingId}::uuid
       FOR UPDATE OF mp, b`.execute(tx);
    const row = r.rows[0];
    if (!row) throw new NotFoundException('BOOKING_NOT_FOUND');
    return row;
  }
}
