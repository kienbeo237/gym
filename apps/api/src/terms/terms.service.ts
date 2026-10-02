import { ConflictException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import type { CurrentTerms, PublishTermsRequest, TermsVersion, TermsVersionSummary } from '@pt/contracts';
import { TenantDb, type Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

/**
 * Điều khoản & chính sách của phòng (tenant_terms, 0023).
 *
 * Mỗi lần lưu là một PHIÊN BẢN mới — bảng chỉ cho thêm, không cho sửa/xoá
 * (REVOKE ở migration). Bản hiệu lực là version lớn nhất.
 */
@Injectable()
export class TermsService {
  constructor(private readonly tdb: TenantDb) {}

  current(): Promise<CurrentTerms> {
    return this.tdb.run(async (tx) => ({ current: await this.banHieuLuc(tx) }));
  }

  versions(): Promise<TermsVersionSummary[]> {
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('tenant_terms as t')
        .leftJoin('identity as i', 'i.id', 't.published_by')
        .select([
          't.version', 't.published_at as publishedAt', 'i.full_name as publishedByName',
          sql<number>`length(t.content)`.as('length'),
        ])
        .orderBy('t.version', 'desc')
        .limit(50)
        .execute();
      return rows.map((r) => ({
        version: r.version,
        publishedAt: new Date(r.publishedAt).toISOString(),
        publishedByName: r.publishedByName,
        length: Number(r.length),
      }));
    });
  }

  /**
   * Đăng phiên bản mới. Nội dung y hệt bản hiện hành thì trả lại bản đó, không
   * sinh phiên bản rỗng nghĩa (bấm "Lưu" hai lần không phải hai lần đổi luật).
   */
  publish(dto: PublishTermsRequest): Promise<TermsVersion> {
    const ctx = requireContext();
    return this.tdb.run(async (tx) => {
      // Hai người lưu cùng lúc: tuần tự hoá việc lấy số phiên bản.
      await sql`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId} || ':terms'))`.execute(tx);

      const hienTai = await tx
        .selectFrom('tenant_terms')
        .select(['version', 'content'])
        .orderBy('version', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (hienTai && hienTai.content === dto.content) {
        return (await this.banHieuLuc(tx))!;
      }

      try {
        await tx
          .insertInto('tenant_terms')
          .values({
            tenant_id: ctx.tenantId,
            version: (hienTai?.version ?? 0) + 1,
            content: dto.content,
            published_by: ctx.identityId,
          })
          .execute();
      } catch (e) {
        if ((e as { code?: string }).code === '23505') {
          throw new ConflictException({ code: 'TERMS_CONFLICT', message: 'Có người vừa lưu điều khoản. Tải lại trang rồi thử lại.' });
        }
        throw e;
      }

      await tx
        .insertInto('audit_log')
        .values({
          tenant_id: ctx.tenantId,
          actor_id: ctx.identityId,
          action: 'TERMS_PUBLISHED',
          entity: 'tenant_terms',
          entity_id: ctx.tenantId,
          before: JSON.stringify({ version: hienTai?.version ?? null }),
          after: JSON.stringify({ version: (hienTai?.version ?? 0) + 1, length: dto.content.length }),
        })
        .execute();

      return (await this.banHieuLuc(tx))!;
    });
  }

  /** Bản hiệu lực = phiên bản lớn nhất. */
  private async banHieuLuc(tx: Tx): Promise<TermsVersion | null> {
    const r = await tx
      .selectFrom('tenant_terms as t')
      .leftJoin('identity as i', 'i.id', 't.published_by')
      .select(['t.version', 't.content', 't.published_at as publishedAt', 'i.full_name as publishedByName'])
      .orderBy('t.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    return r ? this.map(r) : null;
  }

  private map(r: { version: number; content: string; publishedAt: Date | string; publishedByName: string | null }): TermsVersion {
    return {
      version: r.version,
      content: r.content,
      publishedAt: new Date(r.publishedAt).toISOString(),
      publishedByName: r.publishedByName,
    };
  }
}
