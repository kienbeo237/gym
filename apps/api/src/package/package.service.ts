import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import type {
  CreatePackageRequest,
  ListPackageQuery,
  Paged,
  PackageSummary,
  UpdatePackageRequest,
} from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

@Injectable()
export class PackageService {
  constructor(private readonly tdb: TenantDb) {}

  async list(q: ListPackageQuery): Promise<Paged<PackageSummary>> {
    return this.tdb.run(async (tx) => {
      const base = tx
        .selectFrom('package_template as p')
        .$if(!q.includeInactive, (qb) => qb.where('p.is_active', '=', true))
        .$if(!!q.kind, (qb) => qb.where('p.kind', '=', q.kind!))
        .$if(!!q.q, (qb) =>
          qb.where((eb) =>
            eb.or([eb('p.name', 'ilike', `%${q.q}%`), eb('p.code', 'ilike', `%${q.q}%`)]),
          ),
        );

      const total = Number(
        (await base.select((eb) => eb.fn.countAll<string>().as('total')).executeTakeFirstOrThrow())
          .total,
      );

      const rows = await base
        .select((eb) => [
          'p.id', 'p.code', 'p.name', 'p.kind', 'p.sessions', 'p.valid_days as validDays',
          'p.price', 'p.is_active as isActive', 'p.sort_order as sortOrder',
          'p.late_cancel_hours as lateCancelHours',
          'p.late_cancel_deducts as lateCancelDeducts',
          'p.no_show_deducts as noShowDeducts',
          eb
            .selectFrom('member_package as mp')
            .select((e) => e.fn.countAll<string>().as('c'))
            .whereRef('mp.template_id', '=', 'p.id')
            .as('soldCount'),
        ])
        .orderBy('p.sort_order', 'asc')
        .orderBy('p.code', 'asc')
        .limit(q.size)
        .offset((q.page - 1) * q.size)
        .execute();

      // Mặc định của phòng, lấy một lần cho cả trang thay vì gọi
      // resolve_booking_policy() cho từng dòng.
      const mac = await tx
        .selectFrom('tenant_policy')
        .select(['late_cancel_hours', 'late_cancel_deducts', 'no_show_deducts'])
        .executeTakeFirstOrThrow();

      return {
        items: rows.map((r) => {
          const keThua: string[] = [];
          if (r.lateCancelHours === null) keThua.push('lateCancelHours');
          if (r.lateCancelDeducts === null) keThua.push('lateCancelDeducts');
          if (r.noShowDeducts === null) keThua.push('noShowDeducts');

          return {
            id: r.id,
            code: r.code,
            name: r.name,
            kind: r.kind as PackageSummary['kind'],
            sessions: r.sessions,
            validDays: r.validDays,
            price: Number(r.price),
            pricePerSession: Math.round(Number(r.price) / r.sessions),
            isActive: r.isActive,
            sortOrder: r.sortOrder,
            soldCount: Number(r.soldCount ?? 0),
            effectivePolicy: {
              lateCancelHours: r.lateCancelHours ?? mac.late_cancel_hours,
              lateCancelDeducts: r.lateCancelDeducts ?? mac.late_cancel_deducts,
              noShowDeducts: r.noShowDeducts ?? mac.no_show_deducts,
              inheritedFields: keThua,
            },
          };
        }),
        page: q.page,
        size: q.size,
        total,
      };
    });
  }

  async create(dto: CreatePackageRequest): Promise<{ id: string; code: string }> {
    const ctx = requireContext();

    return this.tdb.run(async (tx) => {
      try {
        const row = await tx
          .insertInto('package_template')
          .values({
            tenant_id: ctx.tenantId,
            code: dto.code,
            name: dto.name,
            kind: dto.kind,
            sessions: dto.sessions,
            valid_days: dto.validDays,
            price: dto.price,
            description: dto.description ?? null,
            sort_order: dto.sortOrder,
            late_cancel_hours: dto.lateCancelHours ?? null,
            late_cancel_deducts: dto.lateCancelDeducts ?? null,
            no_show_deducts: dto.noShowDeducts ?? null,
          })
          .returning(['id', 'code'])
          .executeTakeFirstOrThrow();

        await this.audit(tx, 'PACKAGE_CREATED', row.id, { code: row.code, price: dto.price });
        return row;
      } catch (e) {
        // uq_pkg_template_code là UNIQUE (tenant_id, code) — phòng khác dùng mã
        // này không ảnh hưởng gì, nên câu báo lỗi chỉ nói về phòng hiện tại.
        if (String(e instanceof Error ? e.message : e).includes('uq_pkg_template_code')) {
          throw new BadRequestException({
            code: 'PACKAGE_CODE_TAKEN',
            message: `Mã gói "${dto.code}" đã được dùng trong phòng tập này`,
          });
        }
        throw e;
      }
    });
  }

  async update(id: string, dto: UpdatePackageRequest): Promise<void> {
    await this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('package_template')
        .set({
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
          ...(dto.sessions !== undefined ? { sessions: dto.sessions } : {}),
          ...(dto.validDays !== undefined ? { valid_days: dto.validDays } : {}),
          ...(dto.price !== undefined ? { price: dto.price } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
          ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
          // `null` ở đây nghĩa là "trả về mặc định của phòng", nên phải phân
          // biệt được với `undefined` (không đụng tới).
          ...(dto.lateCancelHours !== undefined ? { late_cancel_hours: dto.lateCancelHours } : {}),
          ...(dto.lateCancelDeducts !== undefined ? { late_cancel_deducts: dto.lateCancelDeducts } : {}),
          ...(dto.noShowDeducts !== undefined ? { no_show_deducts: dto.noShowDeducts } : {}),
        })
        .where('id', '=', id)
        .executeTakeFirst();

      if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('PACKAGE_NOT_FOUND');
      await this.audit(tx, 'PACKAGE_UPDATED', id, dto as Record<string, unknown>);
    });
  }

  /**
   * Ngừng bán. Gói ĐÃ BÁN từ mẫu này vẫn chạy bình thường — member_package đã
   * chụp ảnh giá, số buổi và tên, nên nó không phụ thuộc mẫu nữa.
   *
   * Không có đường xoá hẳn: template_id là khoá ngoại của member_package, và
   * xoá được chỉ khi chưa bán dòng nào — ca đó hiếm tới mức không đáng có thêm
   * một endpoint mà ai cũng có thể bấm nhầm.
   */
  async archive(id: string): Promise<{ soldCount: number }> {
    return this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('package_template')
        .set({ is_active: false })
        .where('id', '=', id)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) throw new NotFoundException('PACKAGE_NOT_FOUND');

      const sold = await tx
        .selectFrom('member_package')
        .select((eb) => eb.fn.countAll<string>().as('c'))
        .where('template_id', '=', id)
        .executeTakeFirstOrThrow();

      await this.audit(tx, 'PACKAGE_ARCHIVED', id, {});
      return { soldCount: Number(sold.c) };
    });
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
        entity: 'package_template',
        entity_id: entityId,
        after: JSON.stringify(after),
      })
      .execute();
  }
}
