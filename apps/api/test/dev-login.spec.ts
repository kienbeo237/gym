/**
 * Đăng nhập nhanh chỉ bằng số điện thoại: cửa phải ĐÓNG trừ khi có cờ và không
 * phải production. Cổng kiểm TRƯỚC khi chạm CSDL, nên dựng service với phụ
 * thuộc rỗng là đủ — lọt qua cổng thì nó vỡ ở `db`, không trả NotFound.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuthService } from '../src/auth/auth.service';

const svc = new AuthService({} as never, {} as never, {} as never, {} as never);
const goc = { NODE_ENV: process.env.NODE_ENV, DEV_LOGIN_BYPASS: process.env.DEV_LOGIN_BYPASS };

function datEnv(env: { NODE_ENV?: string; DEV_LOGIN_BYPASS?: string }) {
  for (const k of ['NODE_ENV', 'DEV_LOGIN_BYPASS'] as const) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

describe('POST /auth/dev-login', () => {
  afterEach(() => datEnv(goc));

  it.each([
    ['không có cờ', { NODE_ENV: 'development' }],
    ['production dù có cờ', { NODE_ENV: 'production', DEV_LOGIN_BYPASS: '1' }],
  ])('404 khi %s', async (_ten, env) => {
    datEnv(env);
    await expect(svc.devLogin('+84901100001')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('có cờ ở dev thì qua cổng (và đi tới bước tra CSDL)', async () => {
    datEnv({ NODE_ENV: 'development', DEV_LOGIN_BYPASS: '1' });
    await expect(svc.devLogin('+84901100001')).rejects.not.toBeInstanceOf(NotFoundException);
  });
});
