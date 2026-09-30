/**
 * Phòng tập bị khoá thì CHỈ ĐỌC; phòng đã đóng thì không gì cả — kiểm ở MỌI
 * request chứ không chỉ lúc đăng nhập (token cũ vẫn còn sống tới 15 phút).
 */
import { describe, expect, it } from 'vitest';
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { TenantStatusGuard } from '../src/common/tenant-status.guard';
import type { TenantDb } from '../src/common/tenant-db.service';

function guardVoi(status: string | null) {
  let soLanDoc = 0;
  const tx = {
    selectFrom: () => ({
      select: () => ({
        executeTakeFirst: async () => {
          soLanDoc++;
          return status ? { status } : undefined;
        },
      }),
    }),
  };
  const tdb = { runAs: (_id: string, fn: (t: unknown) => unknown) => fn(tx) } as unknown as TenantDb;
  return { guard: new TenantStatusGuard(tdb), soLanDoc: () => soLanDoc };
}

function ctx(method: string, user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ method, user }) }) } as unknown as ExecutionContext;
}

const NV = { sub: 'u', tid: 't1', roles: ['OWNER'] };

describe('TenantStatusGuard', () => {
  it('phòng đang hoạt động: đọc và ghi đều qua', async () => {
    const { guard } = guardVoi('ACTIVE');
    await expect(guard.canActivate(ctx('GET', NV))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('POST', NV))).resolves.toBe(true);
  });

  it('quá hạn (PAST_DUE) vẫn dùng bình thường — chỉ bị nhắc', async () => {
    const { guard } = guardVoi('PAST_DUE');
    await expect(guard.canActivate(ctx('PATCH', NV))).resolves.toBe(true);
  });

  it('bị khoá: GET qua, mọi phương thức ghi bị từ chối', async () => {
    const { guard } = guardVoi('SUSPENDED');
    await expect(guard.canActivate(ctx('GET', NV))).resolves.toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(guard.canActivate(ctx(m, NV))).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('đã đóng: kể cả GET cũng bị từ chối', async () => {
    const { guard } = guardVoi('CLOSED');
    await expect(guard.canActivate(ctx('GET', NV))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('route công khai và phiên nền tảng không bị kiểm (không có tid)', async () => {
    const { guard, soLanDoc } = guardVoi('CLOSED');
    await expect(guard.canActivate(ctx('POST', undefined))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('POST', { sub: 'u', scope: 'platform', pa: 'OPS' }))).resolves.toBe(true);
    expect(soLanDoc()).toBe(0);
  });

  it('nhớ đệm: hai request liền nhau chỉ đọc CSDL một lần', async () => {
    const { guard, soLanDoc } = guardVoi('ACTIVE');
    await guard.canActivate(ctx('GET', NV));
    await guard.canActivate(ctx('GET', NV));
    expect(soLanDoc()).toBe(1);
  });
});
