/**
 * Hợp đồng dùng chung giữa API và web.
 *
 * Nguồn sự thật của DTO nằm ở đây, khai bằng zod một lần: NestJS dùng để
 * validate, Next.js suy type từ chính schema đó. Hai bên khai riêng là hai bên
 * trôi khỏi nhau — lớp lỗi chỉ lộ ra lúc chạy.
 */
// `export type *`, không phải `export *`: db.d.ts chỉ có kiểu, không có mã chạy.
// Dùng `export *` thì tsc sinh require('./db.js') và runtime vỡ vì tệp không tồn tại.
export type * from './db.js';
export * from './auth.js';
export * from './common.js';
export * from './member.js';
export * from './trainer.js';
export * from './package.js';
export * from './storage.js';
export * from './sale.js';
export * from './billing.js';
