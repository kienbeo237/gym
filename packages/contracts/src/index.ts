/**
 * Hợp đồng dùng chung giữa API và web.
 *
 * Nguồn sự thật của DTO nằm ở đây, khai bằng zod một lần: NestJS dùng để
 * validate, Next.js suy type từ chính schema đó. Hai bên khai riêng là hai bên
 * trôi khỏi nhau — lớp lỗi chỉ lộ ra lúc chạy.
 */
// CHỈ xuất `DB` và các alias kiểu, KHÔNG xuất interface của từng bảng.
//
// Lý do cụ thể: kysely-codegen đặt tên interface theo bảng ở dạng PascalCase
// (`payroll_line` -> `PayrollLine`), và DTO tự viết rất dễ trùng tên với chúng.
// Khi trùng, TypeScript chọn một trong hai một cách khó đoán rồi báo lỗi ở nơi
// hoàn toàn không liên quan — đã mắc đúng với `PayrollLine`.
//
// Interface của từng bảng là chi tiết cài đặt của tầng dữ liệu; bên ngoài chỉ
// cần `DB` (vẫn tới được từng bảng qua `DB['ten_bang']`).
//
// `export type` chứ không `export`: db.ts chỉ có kiểu, không có mã chạy, nên
// `export *` sẽ sinh require('./db.js') và vỡ lúc chạy.
export type {
  DB,
  DateString,
  Generated,
  Int8,
  Json,
  Numeric,
  Timestamp,
} from './db.js';
export * from './auth.js';
export * from './common.js';
export * from './member.js';
export * from './trainer.js';
export * from './package.js';
export * from './storage.js';
export * from './sale.js';
export * from './billing.js';
export * from './booking.js';
export * from './report.js';
export * from './me.js';
