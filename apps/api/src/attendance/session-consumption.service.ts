import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { CommissionService } from '../commission/commission.service';

export type LyDoTieuThu = 'CHECKIN' | 'NO_SHOW' | 'LATE_CANCEL';

export type KetQuaTieuThu = {
  revenueRecognized: number;
  teachCommission: number;
  sessionsRemaining: number;
  sessionsTotal: number;
};

/**
 * MỘT nơi duy nhất trừ buổi tập khỏi hợp đồng.
 *
 * Có ba đường dẫn tới đây — điểm danh, vắng mặt, huỷ muộn — và cả ba đều phải
 * làm đúng cùng một bộ năm việc. Viết ba lần là ba lần lệch nhau, và lệch ở
 * đây là lệch tiền:
 *
 *   1. sổ cái  -1 buổi (idempotent nhờ uq_ledger_checkin)
 *   2. sessions_used += 1   (sessions_remaining do trigger tự lo)
 *   3. revenue_entry        — doanh thu GHI NHẬN, một dòng một buổi
 *   4. commission_entry     — hoa hồng DẠY, chỉ khi thật sự có buổi dạy
 *   5. notification_outbox  — nhắc hội viên số buổi còn lại
 */
@Injectable()
export class SessionConsumptionService {
  private readonly log = new Logger(SessionConsumptionService.name);

  constructor(private readonly commission: CommissionService) {}

  /**
   * Đơn giá một buổi, có xử lý phần dư.
   *
   * `price_net / sessions_total` làm tròn từng buổi sẽ lệch tổng vài đồng mỗi
   * hợp đồng — kế toán sẽ trả lại báo cáo. Nên buổi CUỐI CÙNG nhận đúng phần
   * còn lại chưa ghi nhận.
   *
   * Buổi vượt quá `sessions_total` (do được TẶNG thêm) ghi nhận 0 đồng: hội
   * viên không trả tiền cho chúng, và view `v_revenue_over_contract` gác đúng
   * điều đó.
   */
  private donGiaBuoi(priceNet: number, sessionsTotal: number, daGhiNhan: number, soBuoiDaGhi: number): number {
    const conLai = priceNet - daGhiNhan;
    if (conLai <= 0) return 0;
    const buoiConTheoHopDong = sessionsTotal - soBuoiDaGhi;
    if (buoiConTheoHopDong <= 1) return conLai;
    return Math.round(priceNet / sessionsTotal);
  }

  /**
   * Trừ một buổi và ghi nhận mọi hệ quả tiền bạc.
   *
   * Bên gọi PHẢI đã khoá `member_package` bằng `SELECT ... FOR UPDATE` và đã
   * kiểm trạng thái hợp đồng. Hàm này chỉ lo phần ghi.
   */
  async consume(
    tx: Tx,
    args: {
      bookingId: string;
      memberPackageId: string;
      trainerId: string;
      memberId: string;
      lyDo: LyDoTieuThu;
      xayRaLuc: Date;
      /** Ghi vào dòng sổ cái — hội viên đọc được ở màn "Lịch sử". */
      ghiChu?: string;
    },
  ): Promise<KetQuaTieuThu> {
    const ctx = requireContext();

    const mp = await tx
      .selectFrom('member_package')
      .select(['price_net', 'sessions_total', 'sessions_used', 'sessions_remaining', 'template_id', 'expires_on'])
      .where('id', '=', args.memberPackageId)
      .executeTakeFirstOrThrow();

    // --- 1. sổ cái --------------------------------------------------------
    await tx
      .insertInto('session_ledger')
      .values({
        tenant_id: ctx.tenantId,
        member_package_id: args.memberPackageId,
        delta: -1,
        reason: args.lyDo,
        ref_type: 'BOOKING',
        ref_id: args.bookingId,
        note: args.ghiChu ?? null,
        created_by: ctx.identityId || null, // rỗng = worker tự đánh vắng
      })
      .execute();

    // --- 2. bản cache số buổi đã dùng -------------------------------------
    await tx
      .updateTable('member_package')
      .set({ sessions_used: sql`sessions_used + 1` })
      .where('id', '=', args.memberPackageId)
      .execute();

    // --- 3. doanh thu ghi nhận -------------------------------------------
    const daGhi = await tx
      .selectFrom('revenue_entry')
      .select((eb) => [
        eb.fn.coalesce(eb.fn.sum<string>('amount'), eb.val('0')).as('tong'),
        eb.fn.countAll<string>().as('so_dong'),
      ])
      .where('member_package_id', '=', args.memberPackageId)
      .executeTakeFirstOrThrow();

    const doanhThu = this.donGiaBuoi(
      Number(mp.price_net),
      mp.sessions_total,
      Number(daGhi.tong),
      Number(daGhi.so_dong),
    );

    await tx
      .insertInto('revenue_entry')
      .values({
        tenant_id: ctx.tenantId,
        member_package_id: args.memberPackageId,
        booking_id: args.bookingId,
        // PT DẠY buổi đó, chốt TẠI ĐÂY. Đổi người phụ trách hợp đồng về sau
        // không được làm đổi doanh số quá khứ.
        trainer_id: args.trainerId,
        amount: doanhThu,
        recognized_at: args.xayRaLuc,
        source: args.lyDo,
      })
      .execute();

    // --- 4. hoa hồng dạy --------------------------------------------------
    //
    // CHỈ khi thật sự có buổi dạy. Vắng mặt và huỷ muộn vẫn TRỪ buổi và vẫn
    // ghi nhận doanh thu (phòng tập đã bán chỗ đó), nhưng không ai dạy cả.
    //
    // [Quy tắc nghiệp vụ cần chủ phòng xác nhận] Nhiều phòng tập VẪN trả công
    // cho huấn luyện viên khi hội viên vắng mặt, vì người đó đã tới và chờ.
    // Muốn đổi thì thêm cột `pay_teach_on_no_show` vào tenant_policy và đọc ở
    // đúng chỗ này — đừng rải điều kiện ra các service gọi tới.
    let hoaHong = 0;
    if (args.lyDo === 'CHECKIN') {
      const ngay = args.xayRaLuc.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      const policy = await this.commission.resolvePolicy(tx, args.trainerId, mp.template_id, ngay);

      if (!policy) {
        this.log.warn(
          `Không có chính sách hoa hồng cho PT ${args.trainerId} ngày ${ngay} — ghi 0 đồng`,
        );
      } else {
        hoaHong =
          policy.teachMode === 'FIXED'
            ? policy.teachFixedAmount
            : Math.round((doanhThu * policy.teachPct) / 100);
      }

      await tx
        .insertInto('commission_entry')
        .values({
          tenant_id: ctx.tenantId,
          trainer_id: args.trainerId,
          kind: 'TEACH',
          member_package_id: args.memberPackageId,
          booking_id: args.bookingId,
          base_amount: doanhThu,
          amount: hoaHong,
          policy_snapshot: JSON.stringify(
            policy ? { ...policy, resolvedOn: ngay } : { missing: true, resolvedOn: ngay },
          ),
          earned_at: args.xayRaLuc,
          period_month: sql`date_trunc('month', ${args.xayRaLuc}::timestamptz
                            AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
        })
        .execute();
    }

    const sau = await tx
      .selectFrom('member_package')
      .select(['sessions_remaining', 'sessions_total'])
      .where('id', '=', args.memberPackageId)
      .executeTakeFirstOrThrow();

    // --- 5. hộp thư đi ----------------------------------------------------
    //
    // Ghi TRONG transaction nghiệp vụ; worker gửi ở tiến trình khác (src/worker.ts).
    // Gọi HTTP tới Zalo ngay ở đây thì mạng chậm sẽ giữ khoá trên
    // member_package và kéo sập cả luồng điểm danh của phòng tập.
    await tx
      .insertInto('notification_outbox')
      .values({
        tenant_id: ctx.tenantId,
        channel: 'ZALO_ZNS',
        template_code: args.lyDo === 'CHECKIN' ? 'CHECKIN_REMAINING' : 'SESSION_DEDUCTED',
        recipient_ref: args.memberId,
        member_id: args.memberId,
        idempotency_key: `${args.lyDo}:${args.bookingId}`,
        payload: JSON.stringify({
          remaining: sau.sessions_remaining,
          total: sau.sessions_total,
          expiresOn: String(mp.expires_on),
          reason: args.lyDo,
          occurredAt: args.xayRaLuc.toISOString(),
        }),
      })
      .onConflict((oc) => oc.doNothing())
      .execute();

    return {
      revenueRecognized: doanhThu,
      teachCommission: hoaHong,
      sessionsRemaining: sau.sessions_remaining,
      sessionsTotal: sau.sessions_total,
    };
  }
}
