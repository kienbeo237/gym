/**
 * Cổng gác cấu hình.
 *
 * Repo công khai, nên lớp lỗi cần chặn không phải "lộ mật khẩu dev" mà là
 * `cp .env.example .env` rồi mang thẳng lên máy chủ: hệ thống chạy hoàn toàn
 * bình thường, không dấu hiệu nào, và ai đọc repo cũng ký được token hợp lệ.
 */
import { describe, expect, it } from 'vitest';
import { assertCauHinhSanSang } from '../src/common/config-guard';

const THAT: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  TENANT_SECRET_KEY: 'c'.repeat(44),
  DATABASE_URL_APP: 'postgres://app_rw:S3cret!@db/pt',
  DATABASE_URL_AUTH: 'postgres://app_auth:S3cret!@db/pt',
  DATABASE_URL_PLATFORM: 'postgres://app_platform:S3cret!@db/pt',
  S3_SECRET_KEY: 'd'.repeat(40),
  REDIS_PASSWORD: 'e'.repeat(24),
};

describe('Cổng gác cấu hình', () => {
  it('cho qua khi mọi bí mật đã đổi', () => {
    expect(() => assertCauHinhSanSang(THAT)).not.toThrow();
  });

  it('KHÔNG chặn ở máy lập trình (phải chạy được ngay sau khi clone)', () => {
    expect(() =>
      assertCauHinhSanSang({ NODE_ENV: 'development', JWT_ACCESS_SECRET: 'local-dev-only' }),
    ).not.toThrow();
  });

  it.each([
    ['JWT_ACCESS_SECRET', 'doi-truoc-khi-len-that-access'],
    ['DATABASE_URL_APP', 'postgres://app_rw:local-dev-only@localhost:55432/pt'],
    ['REDIS_PASSWORD', 'local-dev-only'],
    ['S3_SECRET_KEY', 'test'],
  ])('chặn khi %s còn là giá trị mẫu', (ten, giaTri) => {
    expect(() => assertCauHinhSanSang({ ...THAT, [ten]: giaTri })).toThrow(
      'CONFIG_NOT_PRODUCTION_READY',
    );
  });

  it('chặn khi thiếu hẳn một biến', () => {
    const { TENANT_SECRET_KEY: _bo, ...thieu } = THAT;
    expect(() => assertCauHinhSanSang(thieu)).toThrow('CONFIG_NOT_PRODUCTION_READY');
  });

  it('chặn bí mật ký token quá ngắn', () => {
    // 31 ký tự: đủ "khác giá trị mẫu" nhưng vẫn đoán được.
    expect(() => assertCauHinhSanSang({ ...THAT, JWT_ACCESS_SECRET: 'x'.repeat(31) })).toThrow(
      'CONFIG_NOT_PRODUCTION_READY',
    );
  });
});
