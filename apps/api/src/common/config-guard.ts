import { Logger } from '@nestjs/common';

/**
 * Chặn khởi động ở môi trường thật khi cấu hình vẫn là giá trị mẫu.
 *
 * Repo này CÔNG KHAI, nên mọi giá trị trong `.env.example` là thứ ai cũng đọc
 * được. Lớp lỗi cần chặn không phải "lộ mật khẩu dev" — mà là `cp .env.example
 * .env` rồi mang thẳng lên máy chủ. Khi đó hệ thống chạy hoàn toàn bình thường,
 * không có dấu hiệu nào, và ai cũng ký được token hợp lệ.
 *
 * Chỉ chặn khi NODE_ENV=production: máy lập trình phải chạy được ngay sau khi
 * clone, không thì không ai dùng.
 */
const GIA_TRI_MAU = [
  'local-dev-only',
  'doi-truoc-khi-len-that-access',
  'doi-truoc-khi-len-that-refresh',
  'doi-truoc-khi-len-that-32-byte-base64',
  'ci-throwaway',
  'ci-access-secret',
  'ci-refresh-secret',
  'test',
];

const PHAI_KIEM = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'TENANT_SECRET_KEY',
  'DATABASE_URL_APP',
  'DATABASE_URL_AUTH',
  'DATABASE_URL_PLATFORM',
  'S3_SECRET_KEY',
  'REDIS_PASSWORD',
];

/**
 * Đăng nhập nhanh chỉ bằng số điện thoại (POST /auth/dev-login) — cho máy lập
 * trình thử vai HLV / hội viên mà không cần kênh gửi OTP hay mật khẩu.
 *
 * Phải có CẢ HAI: bật tường minh `DEV_LOGIN_BYPASS=1` VÀ NODE_ENV khác
 * production. Chỉ dựa vào NODE_ENV thì một máy chủ quên đặt NODE_ENV (mặc định
 * coi là development) sẽ mở cửa cho bất kỳ ai gõ số điện thoại của người khác.
 */
export function devLoginBat(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DEV_LOGIN_BYPASS === '1' && (env.NODE_ENV ?? 'development') !== 'production';
}

export function assertCauHinhSanSang(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV ?? 'development') !== 'production') return;

  const loi: string[] = [];

  for (const ten of PHAI_KIEM) {
    const v = env[ten];
    if (!v) {
      loi.push(`${ten}: chưa đặt`);
      continue;
    }
    if (GIA_TRI_MAU.some((mau) => v.includes(mau))) {
      loi.push(`${ten}: vẫn là giá trị mẫu của .env.example`);
    }
  }

  // Bí mật ký token ngắn thì đoán được. 32 ký tự là mức tối thiểu hợp lý cho
  // HS256; sinh bằng `openssl rand -base64 48`.
  for (const ten of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    const v = env[ten];
    if (v && v.length < 32) loi.push(`${ten}: quá ngắn (${v.length} ký tự, cần ≥ 32)`);
  }

  // Driver log của SMS ghi NGUYÊN mã OTP ra log — ở môi trường thật đó là lộ mã.
  if (env.SMS_DRIVER === 'log') loi.push('SMS_DRIVER: "log" ghi mã OTP ra log, không dùng ở môi trường thật');

  // devLoginBat() đã tự tắt khi NODE_ENV=production, nên cờ này ở đây không mở
  // được gì — nhưng nó cho thấy ai đó định bật đăng nhập không mật khẩu trên máy
  // chủ thật. Từ chối khởi động để người đó biết, thay vì im lặng bỏ qua.
  if (env.DEV_LOGIN_BYPASS) loi.push('DEV_LOGIN_BYPASS: chỉ dùng ở máy lập trình, xoá khỏi cấu hình môi trường thật');

  if (loi.length > 0) {
    new Logger('config').error(
      `Từ chối khởi động — cấu hình chưa sẵn sàng cho môi trường thật:\n  ` +
        loi.join('\n  ') +
        `\n\nSinh bí mật mới: openssl rand -base64 48`,
    );
    // Ném chứ không process.exit: để test gọi được hàm này mà không giết
    // tiến trình chạy test.
    throw new Error('CONFIG_NOT_PRODUCTION_READY');
  }
}
