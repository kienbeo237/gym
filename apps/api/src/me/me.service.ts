import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  MyInvoice,
  MyLedgerEntry,
  MyLedgerQuery,
  MyPackage,
  MySummary,
  ProgressEntry,
  SaveProgressRequest,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

const TZ = 'Asia/Ho_Chi_Minh';

/** Sổ cái dùng mã enum; hội viên đọc câu tiếng Việt. */
const NHAN_LY_DO: Record<string, string> = {
  PURCHASE: 'Mua gói tập',
  CHECKIN: 'Điểm danh buổi tập',
  REVOKE_CHECKIN: 'Huỷ điểm danh (hoàn lại buổi)',
  NO_SHOW: 'Vắng mặt không báo trước',
  LATE_CANCEL: 'Huỷ muộn',
  BONUS: 'Được tặng thêm buổi',
  ADJUSTMENT: 'Điều chỉnh của phòng tập',
  TRANSFER_IN: 'Chuyển buổi sang gói này',
  TRANSFER_OUT: 'Chuyển buổi sang gói khác',
  EXPIRE: 'Hết hạn gói',
  REFUND: 'Hoàn tiền / huỷ hợp đồng',
};

/**
 * Mọi thứ app hội viên cần, và KHÔNG gì hơn.
 *
 * Mỗi hàm ở đây tự lấy `memberId` từ token. Không hàm nào nhận nó làm tham số —
 * nhận tham số là mở đường cho một hội viên đọc hồ sơ người khác chỉ bằng cách
 * đổi một chuỗi trên thanh địa chỉ.
 */
@Injectable()
export class MeService {
  constructor(private readonly tdb: TenantDb) {}

  /** Hồ sơ hội viên của chính người đang gọi. Ném lỗi nếu chưa có. */
  private memberId(): string {
    const ctx = requireContext();
    if (!ctx.memberId) {
      throw new ForbiddenException({
        code: 'NO_MEMBER_PROFILE',
        message: 'Tài khoản chưa gắn hồ sơ hội viên tại phòng tập này',
      });
    }
    return ctx.memberId;
  }

  async summary(): Promise<MySummary> {
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      const me = await tx
        .selectFrom('member as m')
        .innerJoin('identity as i', 'i.id', 'm.identity_id')
        .select(['m.code', 'i.full_name as fullName'])
        .where('m.id', '=', memberId)
        .executeTakeFirstOrThrow();

      const rows = await tx
        .selectFrom('member_package as mp')
        .leftJoin('trainer as t', 't.id', 'mp.trainer_id')
        .leftJoin('identity as ti', 'ti.id', 't.identity_id')
        .select((eb) => [
          'mp.id', 'mp.code', 'mp.name_snapshot as name',
          'mp.sessions_total as sessionsTotal', 'mp.sessions_bonus as sessionsBonus',
          'mp.sessions_remaining as sessionsRemaining',
          'mp.sessions_used as sessionsUsed', 'mp.starts_on as startsOn',
          'mp.expires_on as expiresOn', 'mp.status',
          'ti.full_name as trainerName',
          eb
            .selectFrom('invoice_item as ii')
            .innerJoin('invoice as inv', 'inv.id', 'ii.invoice_id')
            .select((e) =>
              e.fn
                .coalesce(e.fn.sum<string>(sql`inv.total_amount - inv.paid_amount`), e.val('0'))
                .as('s'),
            )
            .whereRef('ii.member_package_id', '=', 'mp.id')
            .where('inv.status', 'in', ['OPEN', 'PARTIALLY_PAID'])
            .as('outstanding'),
        ])
        .where('mp.member_id', '=', memberId)
        .where('mp.status', '<>', 'CANCELLED')
        .orderBy('mp.status')
        .orderBy('mp.expires_on', 'desc')
        .execute();

      const homNay = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const packages: MyPackage[] = rows.map((r) => ({
        id: r.id,
        code: r.code,
        name: r.name,
        sessionsTotal: r.sessionsTotal,
        sessionsBonus: r.sessionsBonus,
        sessionsRemaining: r.sessionsRemaining,
        sessionsUsed: r.sessionsUsed,
        startsOn: String(r.startsOn),
        expiresOn: String(r.expiresOn),
        daysLeft: soNgay(homNay, String(r.expiresOn)),
        status: r.status,
        trainerName: r.trainerName,
        outstanding: Number(r.outstanding ?? 0),
      }));

      const ke = await tx
        .selectFrom('booking as b')
        .innerJoin('trainer as t', 't.id', 'b.trainer_id')
        .innerJoin('identity as ti', 'ti.id', 't.identity_id')
        .select(['b.id', 'b.starts_at as startsAt', 'b.ends_at as endsAt', 'ti.full_name as trainerName'])
        .where('b.member_id', '=', memberId)
        .where('b.status', '=', 'BOOKED')
        .orderBy('b.starts_at')
        .limit(1)
        .executeTakeFirst();

      // Cảnh báo tính ở BACKEND, không ở giao diện: ngưỡng phải giống hệt cái
      // mà chiến dịch nhắc gia hạn dùng, nếu không hội viên thấy "sắp hết" trên
      // màn hình mà không nhận tin, hoặc ngược lại.
      //
      // Nên ngưỡng ĐỌC TỪ chiến dịch đang bật của phòng; chỉ khi phòng không bật
      // chiến dịch nào thì mới dùng mặc định.
      const nguong = await tx
        .selectFrom('campaign')
        .select(['trigger_type', (eb) => eb.fn.max('threshold').as('n')])
        .where('is_active', '=', true)
        .where('trigger_type', 'in', ['LOW_SESSION_BALANCE', 'PACKAGE_EXPIRING'])
        .groupBy('trigger_type')
        .execute();
      const nguongBuoi = nguong.find((r) => r.trigger_type === 'LOW_SESSION_BALANCE')?.n ?? 3;
      const nguongNgay = nguong.find((r) => r.trigger_type === 'PACKAGE_EXPIRING')?.n ?? 14;

      const warnings: MySummary['warnings'] = [];
      for (const p of packages.filter((x) => x.status === 'ACTIVE')) {
        if (p.sessionsRemaining === 0) {
          warnings.push({ packageCode: p.code, kind: 'USED_UP', message: `Gói ${p.name} đã hết buổi tập.` });
        } else if (p.sessionsRemaining <= nguongBuoi) {
          warnings.push({
            packageCode: p.code, kind: 'LOW_SESSIONS',
            message: `Gói ${p.name} chỉ còn ${p.sessionsRemaining} buổi.`,
          });
        }
        if (p.daysLeft < 0) {
          warnings.push({ packageCode: p.code, kind: 'EXPIRED', message: `Gói ${p.name} đã hết hạn.` });
        } else if (p.daysLeft <= nguongNgay) {
          warnings.push({
            packageCode: p.code, kind: 'EXPIRING',
            message: `Gói ${p.name} hết hạn sau ${p.daysLeft} ngày.`,
          });
        }
      }

      return {
        memberCode: me.code,
        fullName: me.fullName,
        packages,
        totalSessionsRemaining: packages
          .filter((p) => p.status === 'ACTIVE')
          .reduce((s, p) => s + p.sessionsRemaining, 0),
        totalOutstanding: packages.reduce((s, p) => s + p.outstanding, 0),
        nextBooking: ke
          ? {
              id: ke.id,
              startsAt: new Date(ke.startsAt).toISOString(),
              endsAt: new Date(ke.endsAt).toISOString(),
              trainerName: ke.trainerName,
              minutesUntil: Math.round((new Date(ke.startsAt).getTime() - Date.now()) / 60_000),
            }
          : null,
        warnings,
      };
    });
  }

  /**
   * Lịch sử buổi tập, đọc từ SỔ CÁI chứ không từ bảng booking.
   *
   * Sổ cái là nguồn sự thật và mỗi dòng có lý do — đó chính là thứ dập tranh
   * chấp "em tập 8 buổi sao trừ 10". Đọc từ booking sẽ bỏ sót buổi tặng thêm và
   * các điều chỉnh của phòng tập.
   */
  async ledger(q: MyLedgerQuery): Promise<MyLedgerEntry[]> {
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('session_ledger as sl')
        .innerJoin('member_package as mp', 'mp.id', 'sl.member_package_id')
        .select(['sl.id', 'sl.delta', 'sl.reason', 'sl.note', 'sl.created_at as at', 'mp.code as packageCode'])
        .where('mp.member_id', '=', memberId)
        .$if(!!q.packageId, (qb) => qb.where('sl.member_package_id', '=', q.packageId!))
        .orderBy('sl.id', 'desc')
        .limit(q.limit)
        .execute();

      // Số dư SAU mỗi dòng: cộng dồn ngược từ dòng mới nhất. Tính ở đây thay vì
      // ở giao diện để mọi nơi hiển thị ra cùng một con số.
      const duHienTai = new Map<string, number>();
      const soDu = await tx
        .selectFrom('member_package')
        .select(['code', 'sessions_remaining'])
        .where('member_id', '=', memberId)
        .execute();
      for (const s of soDu) duHienTai.set(s.code, s.sessions_remaining);

      return rows.map((r) => {
        const truoc = duHienTai.get(r.packageCode) ?? 0;
        duHienTai.set(r.packageCode, truoc - r.delta);
        return {
          id: String(r.id),
          packageCode: r.packageCode,
          delta: r.delta,
          reason: r.reason,
          label: NHAN_LY_DO[r.reason] ?? r.reason,
          note: r.note,
          at: new Date(r.at).toISOString(),
          balanceAfter: truoc,
        };
      });
    });
  }

  async invoices(): Promise<MyInvoice[]> {
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('invoice as inv')
        .select((eb) => [
          'inv.id', 'inv.code', 'inv.issued_at as issuedAt',
          'inv.total_amount as totalAmount', 'inv.paid_amount as paidAmount',
          'inv.status', 'inv.is_installment as isInstallment',
          eb
            .selectFrom('payment_schedule as ps')
            .select('ps.due_date')
            .whereRef('ps.invoice_id', '=', 'inv.id')
            .where('ps.status', 'in', ['DUE', 'OVERDUE'])
            .orderBy('ps.due_date')
            .limit(1)
            .as('nextDueDate'),
          eb
            .selectFrom('payment_schedule as ps')
            .select('ps.amount')
            .whereRef('ps.invoice_id', '=', 'inv.id')
            .where('ps.status', 'in', ['DUE', 'OVERDUE'])
            .orderBy('ps.due_date')
            .limit(1)
            .as('nextDueAmount'),
        ])
        .where('inv.member_id', '=', memberId)
        .where('inv.status', '<>', 'DRAFT')
        .orderBy('inv.issued_at', 'desc')
        .execute();

      return rows.map((r) => ({
        id: r.id,
        code: r.code,
        issuedAt: new Date(r.issuedAt).toISOString(),
        totalAmount: Number(r.totalAmount),
        paidAmount: Number(r.paidAmount),
        outstanding: Number(r.totalAmount) - Number(r.paidAmount),
        status: r.status,
        isInstallment: r.isInstallment,
        nextDueDate: r.nextDueDate ? String(r.nextDueDate) : null,
        nextDueAmount: r.nextDueAmount == null ? null : Number(r.nextDueAmount),
      }));
    });
  }

  // -------------------------------------------------------------------------
  // Nhật ký tiến độ
  // -------------------------------------------------------------------------

  async progress(): Promise<ProgressEntry[]> {
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('member_progress')
        .select([
          'id', 'recorded_on as recordedOn', 'weight_hg as weightHg',
          'body_fat_pm as bodyFatPm', 'muscle_hg as muscleHg', 'note',
          'photo_file_id as photoFileId',
        ])
        .where('member_id', '=', memberId)
        .orderBy('recorded_on', 'desc')
        .limit(200)
        .execute();

      // Chênh lệch so với bản ghi LIỀN TRƯỚC theo thời gian. Danh sách đang xếp
      // giảm dần nên "liền trước" là phần tử SAU trong mảng.
      return rows.map((r, i) => {
        const truoc = rows[i + 1];
        const nay = r.weightHg == null ? null : r.weightHg / 10;
        const cu = truoc?.weightHg == null ? null : truoc.weightHg / 10;
        return {
          id: r.id,
          recordedOn: String(r.recordedOn),
          weightKg: nay,
          bodyFatPct: r.bodyFatPm == null ? null : r.bodyFatPm / 10,
          muscleKg: r.muscleHg == null ? null : r.muscleHg / 10,
          note: r.note,
          photoFileId: r.photoFileId,
          weightDelta: nay != null && cu != null ? Math.round((nay - cu) * 10) / 10 : null,
        };
      });
    });
  }

  async saveProgress(dto: SaveProgressRequest): Promise<{ id: string }> {
    const ctx = requireContext();
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      if (dto.photoFileId) {
        // Ảnh phải thuộc về CHÍNH hội viên này. RLS chỉ chặn tệp của phòng tập
        // khác; trong cùng phòng thì không có gì ngăn gắn ảnh của người khác
        // vào nhật ký của mình.
        const f = await tx
          .selectFrom('file_object')
          .select(['owner_id', 'owner_type', 'status'])
          .where('id', '=', dto.photoFileId)
          .executeTakeFirst();
        if (!f || f.owner_id !== memberId || f.owner_type !== 'PROGRESS_PHOTO') {
          throw new NotFoundException('FILE_NOT_FOUND');
        }
        if (f.status !== 'CONFIRMED') {
          throw new BadRequestException({
            code: 'FILE_NOT_CONFIRMED',
            message: 'Ảnh chưa tải lên xong',
          });
        }
      }

      const row = await tx
        .insertInto('member_progress')
        .values({
          tenant_id: ctx.tenantId,
          member_id: memberId,
          recorded_on: dto.recordedOn,
          weight_hg: dto.weightKg == null ? null : Math.round(dto.weightKg * 10),
          body_fat_pm: dto.bodyFatPct == null ? null : Math.round(dto.bodyFatPct * 10),
          muscle_hg: dto.muscleKg == null ? null : Math.round(dto.muscleKg * 10),
          note: dto.note ?? null,
          photo_file_id: dto.photoFileId ?? null,
          created_by: ctx.identityId,
        })
        // Đo hai lần trong ngày thì GHI ĐÈ, không sinh hai dòng làm biểu đồ
        // răng cưa (uq_member_progress_day).
        .onConflict((oc) =>
          oc.columns(['member_id', 'recorded_on']).doUpdateSet({
            weight_hg: (eb) => eb.ref('excluded.weight_hg'),
            body_fat_pm: (eb) => eb.ref('excluded.body_fat_pm'),
            muscle_hg: (eb) => eb.ref('excluded.muscle_hg'),
            note: (eb) => eb.ref('excluded.note'),
            photo_file_id: (eb) => eb.ref('excluded.photo_file_id'),
          }),
        )
        .returning('id')
        .executeTakeFirstOrThrow();

      return { id: row.id };
    });
  }

  /** Huấn luyện viên của chính mình — chỉ tên và bậc, không số liệu kinh doanh. */
  async myTrainers(): Promise<{ id: string; name: string; level: string | null }[]> {
    const memberId = this.memberId();

    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('member_package as mp')
        .innerJoin('trainer as t', 't.id', 'mp.trainer_id')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .select(['t.id', 'i.full_name as name', 't.level'])
        .where('mp.member_id', '=', memberId)
        .where('mp.status', '=', 'ACTIVE')
        .distinct()
        .execute();
      return rows;
    });
  }
}

/** Số ngày từ `tu` tới `den`, cả hai là 'YYYY-MM-DD'. */
function soNgay(tu: string, den: string): number {
  return Math.round(
    (Date.parse(`${den}T00:00:00Z`) - Date.parse(`${tu}T00:00:00Z`)) / 86_400_000,
  );
}
