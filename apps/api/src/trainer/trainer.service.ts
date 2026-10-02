import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateTrainerRequest,
  ListTrainerQuery,
  Paged,
  SetAvailabilityRequest,
  TrainerDetail,
  TrainerOption,
  TrainerSummary,
  UpdateTrainerRequest,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { loiHanMucGoi } from '../common/saas-policy';

@Injectable()
export class TrainerService {
  constructor(private readonly tdb: TenantDb) {}

  /** HLV đang làm, cho ô chọn. Không kèm số liệu nào — xem TrainerOption. */
  async options(): Promise<TrainerOption[]> {
    return this.tdb.run((tx) =>
      tx
        .selectFrom('trainer as t')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .select(['t.id', 't.code', 'i.full_name as fullName'])
        .where('t.status', '=', 'ACTIVE')
        .orderBy('i.full_name')
        .execute(),
    );
  }

  async list(q: ListTrainerQuery): Promise<Paged<TrainerSummary>> {
    return this.tdb.run(async (tx) => {
      const base = tx
        .selectFrom('trainer as t')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .$if(!!q.q, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('i.full_name', 'ilike', `%${q.q}%`),
              eb('i.phone', 'like', `%${q.q}%`),
              eb('t.code', 'ilike', `%${q.q}%`),
            ]),
          ),
        )
        .$if(!!q.status, (qb) => qb.where('t.status', '=', q.status!));

      const total = Number(
        (
          await base
            .select((eb) => eb.fn.countAll<string>().as('total'))
            .executeTakeFirstOrThrow()
        ).total,
      );

      // Mốc tháng cắt theo GIỜ VIỆT NAM. Buổi 6h sáng ngày 1 theo giờ VN là 23h
      // ngày 30 theo UTC — gộp theo UTC là lệch đúng những ngày đầu/cuối tháng,
      // và chỉ lộ ra lúc chốt lương.
      const dauThang = sql<Date>`date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')
                                 AT TIME ZONE 'Asia/Ho_Chi_Minh'`;

      const rows = await base
        .select((eb) => [
          't.id',
          't.code',
          't.level',
          't.status',
          't.avatar_key as avatarKey',
          'i.full_name as fullName',
          'i.phone',
          eb
            .selectFrom('member_package as mp')
            .select((e) => e.fn.count<string>('mp.member_id').distinct().as('c'))
            .whereRef('mp.trainer_id', '=', 't.id')
            .where('mp.status', '=', 'ACTIVE')
            .as('activeMembers'),
          eb
            .selectFrom('revenue_entry as r')
            .select((e) => e.fn.countAll<string>().as('c'))
            .whereRef('r.trainer_id', '=', 't.id')
            .where('r.recognized_at', '>=', dauThang)
            .as('sessionsThisMonth'),
          eb
            .selectFrom('revenue_entry as r')
            .select((e) => e.fn.coalesce(e.fn.sum<string>('r.amount'), e.val('0')).as('s'))
            .whereRef('r.trainer_id', '=', 't.id')
            .where('r.recognized_at', '>=', dauThang)
            .as('revenueThisMonth'),
          eb
            .selectFrom('commission_entry as c')
            .select((e) => e.fn.coalesce(e.fn.sum<string>('c.amount'), e.val('0')).as('s'))
            .whereRef('c.trainer_id', '=', 't.id')
            .where('c.earned_at', '>=', dauThang)
            .as('commissionThisMonth'),
        ])
        .orderBy('t.status', 'asc')
        .orderBy('t.code', 'asc')
        .limit(q.size)
        .offset((q.page - 1) * q.size)
        .execute();

      return {
        items: rows.map((r) => ({
          id: r.id,
          code: r.code,
          fullName: r.fullName,
          phone: r.phone,
          level: r.level,
          status: r.status,
          avatarKey: r.avatarKey,
          activeMembers: Number(r.activeMembers ?? 0),
          sessionsThisMonth: Number(r.sessionsThisMonth ?? 0),
          revenueThisMonth: Number(r.revenueThisMonth ?? 0),
          commissionThisMonth: Number(r.commissionThisMonth ?? 0),
        })),
        page: q.page,
        size: q.size,
        total,
      };
    });
  }

  async detail(id: string): Promise<TrainerDetail> {
    return this.tdb.run(async (tx) => {
      const t = await tx
        .selectFrom('trainer as t')
        .innerJoin('identity as i', 'i.id', 't.identity_id')
        .select([
          't.id', 't.code', 'i.full_name as fullName', 'i.phone', 'i.email', 't.level', 't.bio', 't.status',
          't.base_salary as baseSalary', 't.hired_on as hiredOn', 't.left_on as leftOn',
        ])
        .where('t.id', '=', id)
        .executeTakeFirst();
      if (!t) throw new NotFoundException('TRAINER_NOT_FOUND');

      // Bản ghi riêng của PT (không theo gói) mới nhất còn mở — có thể là bản
      // "từ ngày mai" vừa đổi hôm nay. Màn sửa phải hiện đúng con số đã nhập.
      const cs = await tx
        .selectFrom('commission_policy')
        .select(['sale_pct', 'teach_mode', 'teach_fixed_amount', 'teach_pct', 'effective_from'])
        .where('trainer_id', '=', id)
        .where('package_template_id', 'is', null)
        .where('effective_to', 'is', null)
        .orderBy('effective_from', 'desc')
        .executeTakeFirst();

      const goi = await tx
        .selectFrom('member_package')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('trainer_id', '=', id)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirstOrThrow();

      return {
        id: t.id,
        code: t.code,
        fullName: t.fullName,
        phone: t.phone,
        email: t.email,
        level: t.level,
        bio: t.bio,
        status: t.status,
        baseSalary: Number(t.baseSalary),
        hiredOn: t.hiredOn ? String(t.hiredOn) : null,
        leftOn: t.leftOn ? String(t.leftOn) : null,
        commission: cs
          ? {
              salePct: Number(cs.sale_pct),
              teachMode: cs.teach_mode as 'FIXED' | 'PCT',
              teachFixedAmount: Number(cs.teach_fixed_amount),
              teachPct: Number(cs.teach_pct),
              effectiveFrom: String(cs.effective_from),
            }
          : null,
        availability: await this.getAvailability(id),
        activePackages: Number(goi.c),
      };
    });
  }

  async create(dto: CreateTrainerRequest): Promise<{ id: string; code: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      await sql`SELECT assert_quota(${ctx.tenantId}::uuid, 'trainer')`
        .execute(tx)
        .catch((e: unknown) => loiHanMucGoi(e, 'trainer'));

      // Cùng cửa hẹp như bên hội viên: PT có thể đã dạy ở phòng khác.
      const resolved = await sql<{ id: string }>`
        SELECT resolve_or_create_identity(
          ${dto.phone}, ${dto.fullName}, ${dto.email ?? null}
        ) AS id`.execute(tx);
      const identityId = resolved.rows[0]!.id;

      await sql`
        INSERT INTO tenant_user (tenant_id, identity_id, role)
        VALUES (${ctx.tenantId}::uuid, ${identityId}::uuid, 'PT')
        ON CONFLICT DO NOTHING`.execute(tx);

      const trung = await tx
        .selectFrom('trainer')
        .select('id')
        .where('identity_id', '=', identityId)
        .executeTakeFirst();
      if (trung) {
        throw new BadRequestException({
          code: 'TRAINER_ALREADY_EXISTS',
          message: 'Số điện thoại này đã là huấn luyện viên của phòng tập',
        });
      }

      const code = dto.code ?? (await this.nextCode(tx));
      const row = await tx
        .insertInto('trainer')
        .values({
          tenant_id: ctx.tenantId,
          identity_id: identityId,
          code,
          level: dto.level ?? null,
          bio: dto.bio ?? null,
          base_salary: dto.baseSalary,
          hired_on: dto.hiredOn ?? null,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();

      if (dto.commission) {
        await tx
          .insertInto('commission_policy')
          .values({
            tenant_id: ctx.tenantId,
            trainer_id: row.id,
            sale_pct: String(dto.commission.salePct),
            teach_mode: dto.commission.teachMode,
            teach_fixed_amount: dto.commission.teachFixedAmount,
            teach_pct: String(dto.commission.teachPct),
            effective_from: sql`current_date`,
          })
          .execute();
      }

      await this.audit(tx, 'TRAINER_CREATED', row.id, { code: row.code, phone: dto.phone });
      return row;
    });
  }

  async update(id: string, dto: UpdateTrainerRequest): Promise<void> {
    const ctx = requireContext();

    await this.tdb.run(async (tx) => {
      const truoc = await tx
        .selectFrom('trainer')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();
      if (!truoc) throw new NotFoundException('TRAINER_NOT_FOUND');

      const doi = {
        ...(dto.level !== undefined ? { level: dto.level } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
        ...(dto.baseSalary !== undefined ? { base_salary: dto.baseSalary } : {}),
        ...(dto.hiredOn !== undefined ? { hired_on: dto.hiredOn } : {}),
      };
      // Chỉ đổi hoa hồng thì không có cột nào của `trainer` để SET — Kysely vẫn
      // sinh `UPDATE trainer SET WHERE …` và PostgreSQL báo lỗi cú pháp (500).
      if (Object.keys(doi).length > 0) {
        await tx.updateTable('trainer').set(doi).where('id', '=', id).execute();
      }

      if (dto.commission) {
        // Chính sách hoa hồng là BẢN GHI CÓ HIỆU LỰC THEO NGÀY, không sửa tại chỗ:
        // hoa hồng đã tính của tháng trước phải giữ nguyên căn cứ của nó.
        // (commission_entry còn chụp ảnh riêng, đây là lớp thứ hai.)
        //
        // Bản "từ ngày mai" của một lần đổi TRƯỚC ĐÓ trong hôm nay chưa từng có
        // hiệu lực — không có lịch sử nào cần giữ, nên thay hẳn. Thiếu bước này
        // thì đổi lần hai trong ngày vỡ: đóng bản đó bằng effective_to = hôm nay
        // < effective_from = mai (comm_policy_date_order), và bản mới trùng
        // effective_from với nó (uq_comm_policy_open).
        await tx
          .deleteFrom('commission_policy')
          .where('trainer_id', '=', id)
          .where('package_template_id', 'is', null)
          .where('effective_from', '>', sql<string>`current_date`)
          .execute();
        await tx
          .updateTable('commission_policy')
          .set({ effective_to: sql`current_date` })
          .where('trainer_id', '=', id)
          .where('package_template_id', 'is', null)
          .where('effective_to', 'is', null)
          .execute();

        await tx
          .insertInto('commission_policy')
          .values({
            tenant_id: ctx.tenantId,
            trainer_id: id,
            sale_pct: String(dto.commission.salePct),
            teach_mode: dto.commission.teachMode,
            teach_fixed_amount: dto.commission.teachFixedAmount,
            teach_pct: String(dto.commission.teachPct),
            effective_from: sql`current_date + 1`,
          })
          .execute();
      }

      await this.audit(tx, 'TRAINER_UPDATED', id, dto as Record<string, unknown>);
    });
  }

  /**
   * Cho PT nghỉ việc. KHÔNG xoá: `revenue_entry` và `commission_entry` trỏ tới
   * bản ghi này, và lịch sử doanh số của những tháng đã chốt phải đọc lại được.
   */
  async deactivate(id: string): Promise<{ activePackages: number }> {
    return this.tdb.run(async (tx) => {
      const conGoi = await tx
        .selectFrom('member_package')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('trainer_id', '=', id)
        .where('status', '=', 'ACTIVE')
        .executeTakeFirstOrThrow();

      const soGoi = Number(conGoi.c);
      if (soGoi > 0) {
        // Chặn thẳng thay vì tự chuyển gói sang PT khác: chuyển ai là quyết
        // định nghiệp vụ, và làm ngầm thì chủ phòng không biết mà đòi tiền.
        throw new BadRequestException({
          code: 'TRAINER_HAS_ACTIVE_PACKAGES',
          message: `Huấn luyện viên còn ${soGoi} gói đang hoạt động. Chuyển hội viên sang người khác trước khi cho nghỉ.`,
          details: { activePackages: soGoi },
        });
      }

      const r = await tx
        .updateTable('trainer')
        .set({ status: 'LEFT', left_on: sql`current_date` })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('TRAINER_NOT_FOUND');

      await this.audit(tx, 'TRAINER_DEACTIVATED', id, {});
      return { activePackages: 0 };
    });
  }

  async setAvailability(id: string, dto: SetAvailabilityRequest): Promise<void> {
    const ctx = requireContext();

    await this.tdb.run(async (tx) => {
      const pt = await tx.selectFrom('trainer').select('id').where('id', '=', id).executeTakeFirst();
      if (!pt) throw new NotFoundException('TRAINER_NOT_FOUND');

      // Xoá hết rồi ghi lại trong MỘT transaction: ràng buộc không-chồng-giờ
      // nằm ở DB, nên vá từng khung sẽ vỡ ở trạng thái trung gian (ví dụ đổi
      // chỗ hai khung cho nhau) dù kết quả cuối hoàn toàn hợp lệ.
      await tx.deleteFrom('trainer_availability').where('trainer_id', '=', id).execute();

      if (dto.slots.length === 0) return;

      try {
        await tx
          .insertInto('trainer_availability')
          .values(
            dto.slots.map((s) => ({
              tenant_id: ctx.tenantId,
              trainer_id: id,
              weekday: s.weekday,
              start_time: s.startTime,
              end_time: s.endTime,
            })),
          )
          .execute();
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes('excl_availability_overlap')) {
          throw new BadRequestException({
            code: 'AVAILABILITY_OVERLAP',
            message: 'Các khung giờ bị chồng lên nhau trong cùng một ngày',
          });
        }
        if (msg.includes('availability_time_order')) {
          throw new BadRequestException({
            code: 'AVAILABILITY_BAD_RANGE',
            message: 'Giờ kết thúc phải sau giờ bắt đầu',
          });
        }
        throw e;
      }

      await this.audit(tx, 'TRAINER_AVAILABILITY_SET', id, { slots: dto.slots.length });
    });
  }

  async getAvailability(id: string): Promise<{ weekday: number; startTime: string; endTime: string }[]> {
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('trainer_availability')
        .select(['weekday', 'start_time', 'end_time'])
        .where('trainer_id', '=', id)
        .orderBy('weekday')
        .orderBy('start_time')
        .execute();
      return rows.map((r) => ({
        weekday: r.weekday,
        startTime: String(r.start_time).slice(0, 5),
        endTime: String(r.end_time).slice(0, 5),
      }));
    });
  }

  // -------------------------------------------------------------------------

  private async nextCode(tx: Tx): Promise<string> {
    const r = await sql<{ n: string }>`
      SELECT coalesce(max(substring(code from '^PT([0-9]+)$')::int), 0) + 1 AS n
      FROM trainer WHERE code ~ '^PT[0-9]+$'`.execute(tx);
    return `PT${String(Number(r.rows[0]!.n)).padStart(3, '0')}`;
  }

  private async audit(
    tx: Tx,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    const ctx = requireContext();
    await tx
      .insertInto('audit_log')
      .values({
        tenant_id: ctx.tenantId,
        actor_id: ctx.identityId,
        action,
        entity: 'trainer',
        entity_id: entityId,
        after: JSON.stringify(after),
      })
      .execute();
  }
}
