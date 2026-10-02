import { Injectable, NotFoundException } from '@nestjs/common';
import type { InboxItem, InboxList } from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

/**
 * Hộp thông báo của NGƯỜI ĐANG ĐĂNG NHẬP. RLS lo ranh giới phòng; lọc
 * identity_id ở mọi câu lo ranh giới người — lễ tân không đọc / đánh dấu được
 * thông báo của HLV, kể cả khi đoán được id.
 */
@Injectable()
export class InboxService {
  constructor(private readonly tdb: TenantDb) {}

  list(limit = 20): Promise<InboxList> {
    const { identityId } = requireContext();
    return this.tdb.run(async (tx) => {
      const rows = await tx
        .selectFrom('staff_notification')
        .select(['id', 'kind', 'title', 'body', 'link', 'created_at', 'read_at'])
        .where('identity_id', '=', identityId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(limit)
        .execute();
      const dem = await tx
        .selectFrom('staff_notification')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('identity_id', '=', identityId)
        .where('read_at', 'is', null)
        .executeTakeFirstOrThrow();
      return {
        items: rows.map(
          (r): InboxItem => ({
            id: r.id,
            kind: r.kind as InboxItem['kind'],
            title: r.title,
            body: r.body,
            link: r.link,
            createdAt: new Date(r.created_at).toISOString(),
            readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
          }),
        ),
        unread: Number(dem.n),
      };
    });
  }

  markRead(id: string): Promise<{ ok: true }> {
    const { identityId } = requireContext();
    return this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('staff_notification')
        .set({ read_at: new Date() })
        .where('id', '=', id)
        .where('identity_id', '=', identityId)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) === 0) {
        // Đã đọc rồi thì thôi; không có / không phải của mình thì 404.
        const co = await tx
          .selectFrom('staff_notification')
          .select('id')
          .where('id', '=', id)
          .where('identity_id', '=', identityId)
          .executeTakeFirst();
        if (!co) throw new NotFoundException({ code: 'NOTIFICATION_NOT_FOUND', message: 'Không tìm thấy thông báo' });
      }
      return { ok: true as const };
    });
  }

  markAllRead(): Promise<{ updated: number }> {
    const { identityId } = requireContext();
    return this.tdb.run(async (tx) => {
      const r = await tx
        .updateTable('staff_notification')
        .set({ read_at: new Date() })
        .where('identity_id', '=', identityId)
        .where('read_at', 'is', null)
        .executeTakeFirst();
      return { updated: Number(r.numUpdatedRows) };
    });
  }
}
