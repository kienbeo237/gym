import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreateMemberRequest,
  ListMemberQuery,
  MemberDetail,
  MemberSummary,
  Paged,
  UpdateMemberRequest,
} from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { loiHanMucGoi } from '../common/saas-policy';

@Injectable()
export class MemberService {
  constructor(private readonly tdb: TenantDb) {}

  async list(q: ListMemberQuery): Promise<Paged<MemberSummary>> {
    return this.tdb.run(async (tx) => {
      // Số buổi còn lại đọc từ `sessions_remaining` — bản cache của SUM(delta),
      // do trigger giữ (0010). KHÔNG tính bằng `sessions_total - sessions_used`:
      // hai đại lượng đó tách nhau khi hợp đồng bị huỷ hoặc được tặng thêm
      // buổi, và công thức trừ sẽ bỏ qua dòng BONUS — hội viên được tặng buổi
      // mà màn hình vẫn báo số cũ. Gác bằng v_session_balance_drift.
      const base = tx
        .selectFrom('member as m')
        .innerJoin('identity as i', 'i.id', 'm.identity_id')
        .$if(!!q.q, (qb) =>
          qb.where((eb) =>
            eb.or([
              eb('i.full_name', 'ilike', `%${q.q}%`),
              eb('i.phone', 'like', `%${q.q}%`),
              eb('m.code', 'ilike', `%${q.q}%`),
            ]),
          ),
        )
        .$if(!!q.status, (qb) => qb.where('m.status', '=', q.status!))
        .$if(!!q.trainerId, (qb) =>
          qb.where((eb) =>
            eb.exists(
              eb
                .selectFrom('member_package as mp')
                .select('mp.id')
                .whereRef('mp.member_id', '=', 'm.id')
                .where('mp.trainer_id', '=', q.trainerId!)
                .where('mp.status', '=', 'ACTIVE'),
            ),
          ),
        );

      const { total } = await base
        .select((eb) => eb.fn.countAll<string>().as('total'))
        .executeTakeFirstOrThrow()
        .then((r) => ({ total: Number(r.total) }));

      const rows = await base
        .select((eb) => [
          'm.id',
          'm.code',
          'm.status',
          'i.full_name as fullName',
          'i.phone',
          eb
            .selectFrom('member_package as mp')
            .select((e) => e.fn.countAll<string>().as('c'))
            .whereRef('mp.member_id', '=', 'm.id')
            .where('mp.status', '=', 'ACTIVE')
            .as('activePackages'),
          eb
            .selectFrom('member_package as mp')
            .select((e) =>
              e.fn.coalesce(e.fn.sum<string>('mp.sessions_remaining'), e.val('0')).as('s'),
            )
            .whereRef('mp.member_id', '=', 'm.id')
            .where('mp.status', '=', 'ACTIVE')
            .as('sessionsRemaining'),
          eb
            .selectFrom('booking as b')
            .select('b.starts_at')
            .whereRef('b.member_id', '=', 'm.id')
            .where('b.status', '=', 'BOOKED')
            .where('b.starts_at', '>', sql<Date>`now()`)
            .orderBy('b.starts_at', 'asc')
            .limit(1)
            .as('nextBookingAt'),
        ])
        .orderBy('m.created_at', 'desc')
        .limit(q.size)
        .offset((q.page - 1) * q.size)
        .execute();

      return {
        items: rows.map((r) => ({
          id: r.id,
          code: r.code,
          fullName: r.fullName,
          phone: r.phone,
          status: r.status,
          activePackages: Number(r.activePackages ?? 0),
          sessionsRemaining: Number(r.sessionsRemaining ?? 0),
          nextBookingAt: r.nextBookingAt ? new Date(r.nextBookingAt).toISOString() : null,
        })),
        page: q.page,
        size: q.size,
        total,
      };
    });
  }

  async detail(id: string): Promise<MemberDetail> {
    return this.tdb.run(async (tx) => {
      const m = await tx
        .selectFrom('member as m')
        .innerJoin('identity as i', 'i.id', 'm.identity_id')
        .select([
          'm.id', 'm.code', 'i.full_name as fullName', 'i.phone', 'i.email', 'm.dob', 'm.gender',
          'm.status', 'm.source', 'm.note', 'm.created_at as joinedAt',
        ])
        .where('m.id', '=', id)
        .executeTakeFirst();
      if (!m) throw new NotFoundException('MEMBER_NOT_FOUND');

      const rows = await tx
        .selectFrom('member_package as mp')
        .innerJoin('package_template as pt', 'pt.id', 'mp.template_id')
        .leftJoin('trainer as t', 't.id', 'mp.trainer_id')
        .leftJoin('identity as ti', 'ti.id', 't.identity_id')
        .select((eb) => [
          'mp.id', 'mp.code', 'mp.name_snapshot as name', 'pt.kind', 'mp.status',
          'mp.sessions_total as sessionsTotal', 'mp.sessions_remaining as sessionsRemaining',
          'mp.starts_on as startsOn', 'mp.expires_on as expiresOn',
          'mp.trainer_id as trainerId', 'ti.full_name as trainerName',
          eb
            .selectFrom('booking as b')
            .select((e) => e.fn.countAll<string>().as('c'))
            .whereRef('b.member_package_id', '=', 'mp.id')
            .where('b.status', '=', 'BOOKED')
            .as('booked'),
          eb
            .selectFrom('invoice_item as ii')
            .innerJoin('invoice as inv', 'inv.id', 'ii.invoice_id')
            .select((e) =>
              e.fn.coalesce(e.fn.sum<string>(sql`inv.total_amount - inv.paid_amount`), e.val('0')).as('s'),
            )
            .whereRef('ii.member_package_id', '=', 'mp.id')
            .where('inv.status', 'in', ['OPEN', 'PARTIALLY_PAID'])
            .as('outstanding'),
        ])
        .where('mp.member_id', '=', id)
        // Đang dùng lên đầu, rồi mới nhất trước.
        .orderBy(sql`mp.status = 'ACTIVE'`, 'desc')
        .orderBy('mp.starts_on', 'desc')
        .execute();

      return {
        id: m.id,
        code: m.code,
        fullName: m.fullName,
        phone: m.phone,
        email: m.email,
        dob: m.dob ? String(m.dob) : null,
        gender: m.gender,
        status: m.status,
        source: m.source,
        note: m.note,
        joinedAt: new Date(m.joinedAt).toISOString(),
        packages: rows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          kind: r.kind,
          status: r.status,
          sessionsTotal: r.sessionsTotal,
          sessionsRemaining: r.sessionsRemaining,
          sessionsBooked: Number(r.booked ?? 0),
          startsOn: String(r.startsOn),
          expiresOn: String(r.expiresOn),
          trainerId: r.trainerId,
          trainerName: r.trainerName,
          outstanding: Number(r.outstanding ?? 0),
        })),
      };
    });
  }

  async update(id: string, dto: UpdateMemberRequest): Promise<void> {
    const ctx = requireContext();
    await this.tdb.run(async (tx) => {
      const truoc = await tx
        .selectFrom('member')
        .select(['dob', 'gender', 'source', 'note', 'status'])
        .where('id', '=', id)
        .forUpdate()
        .executeTakeFirst();
      if (!truoc) throw new NotFoundException('MEMBER_NOT_FOUND');

      const doi = {
        ...(dto.dob !== undefined ? { dob: dto.dob } : {}),
        ...(dto.gender !== undefined ? { gender: dto.gender } : {}),
        ...(dto.source !== undefined ? { source: dto.source } : {}),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
      };
      // Body rỗng: không có gì để SET (Kysely sẽ sinh SQL sai cú pháp).
      if (Object.keys(doi).length === 0) return;
      await tx.updateTable('member').set(doi).where('id', '=', id).execute();

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'MEMBER_UPDATED',
          entity: 'member',
          entity_id: id,
          before: JSON.stringify(truoc),
          after: JSON.stringify(dto),
        })
        .execute();
    });
  }

  async create(dto: CreateMemberRequest): Promise<{ id: string; code: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      // 1) Hạn mức gói SaaS. Hàm này giữ advisory lock theo (tenant,'member')
      //    tới hết transaction — nhờ đó bước sinh mã hội viên bên dưới cũng
      //    được tuần tự hoá, không cần khoá thứ hai.
      await sql`SELECT assert_quota(${ctx.tenantId}::uuid, 'member')`
        .execute(tx)
        .catch((e: unknown) => loiHanMucGoi(e, 'member'));

      // 2) Người này có thể ĐÃ có định danh vì đang tập ở phòng khác. RLS cố ý
      //    không cho đọc định danh đó, nên đi qua cửa hẹp SECURITY DEFINER —
      //    nó trả về đúng một uuid, không lộ dữ liệu phòng khác.
      const resolved = await sql<{ id: string }>`
        SELECT resolve_or_create_identity(
          ${dto.phone}, ${dto.fullName}, ${dto.email ?? null}
        ) AS id`.execute(tx);
      const identityId = resolved.rows[0]!.id;

      // 3) Gắn vai trò MEMBER tại phòng này. Có sẵn thì thôi.
      await sql`
        INSERT INTO tenant_user (tenant_id, identity_id, role)
        VALUES (${ctx.tenantId}::uuid, ${identityId}::uuid, 'MEMBER')
        ON CONFLICT DO NOTHING`.execute(tx);

      const existing = await tx
        .selectFrom('member')
        .select('id')
        .where('identity_id', '=', identityId)
        .executeTakeFirst();
      if (existing) {
        throw new BadRequestException({
          code: 'MEMBER_ALREADY_EXISTS',
          message: 'Số điện thoại này đã là hội viên của phòng tập',
        });
      }

      const code = dto.code ?? (await this.nextCode(tx));
      const row = await tx
        .insertInto('member')
        .values({
          tenant_id: ctx.tenantId,
          identity_id: identityId,
          code,
          dob: dto.dob ?? null,
          gender: dto.gender ?? null,
          source: dto.source ?? null,
          note: dto.note ?? null,
        })
        .returning(['id', 'code'])
        .executeTakeFirstOrThrow();

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'MEMBER_CREATED',
          entity: 'member',
          entity_id: row.id,
          after: JSON.stringify({ code: row.code, phone: dto.phone }),
        })
        .execute();

      return row;
    });
  }

  /** Mã hội viên kế tiếp. An toàn nhờ advisory lock mà assert_quota đang giữ. */
  private async nextCode(tx: Parameters<Parameters<TenantDb['run']>[0]>[0]): Promise<string> {
    const r = await sql<{ n: string }>`
      SELECT coalesce(max(substring(code from '^HV([0-9]+)$')::int), 0) + 1 AS n
      FROM member WHERE code ~ '^HV[0-9]+$'`.execute(tx);
    return `HV${String(Number(r.rows[0]!.n)).padStart(4, '0')}`;
  }
}
