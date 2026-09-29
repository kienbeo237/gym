import { BadRequestException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CreateMemberRequest, ListMemberQuery, MemberSummary, Paged } from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

@Injectable()
export class MemberService {
  constructor(private readonly tdb: TenantDb) {}

  async list(q: ListMemberQuery): Promise<Paged<MemberSummary>> {
    return this.tdb.run(async (tx) => {
      // Số buổi còn lại tính từ member_package (bản cache), KHÔNG từ session_ledger:
      // danh sách phải nhanh, và bản cache đã được job đối soát đêm canh
      // (v_session_balance_drift). Màn chi tiết thì đọc sổ cái.
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
              e.fn
                .coalesce(e.fn.sum<string>(sql`mp.sessions_total - mp.sessions_used`), e.val('0'))
                .as('s'),
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

  async create(dto: CreateMemberRequest): Promise<{ id: string; code: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      // 1) Hạn mức gói SaaS. Hàm này giữ advisory lock theo (tenant,'member')
      //    tới hết transaction — nhờ đó bước sinh mã hội viên bên dưới cũng
      //    được tuần tự hoá, không cần khoá thứ hai.
      try {
        await sql`SELECT assert_quota(${ctx.tenantId}::uuid, 'member')`.execute(tx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('QUOTA_EXCEEDED')) {
          throw new BadRequestException({
            code: 'QUOTA_EXCEEDED',
            message: 'Đã đạt số hội viên tối đa của gói dịch vụ hiện tại',
          });
        }
        throw e;
      }

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
