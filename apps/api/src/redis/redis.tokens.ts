/**
 * Token DI để RIÊNG, không nằm trong redis.module.ts.
 *
 * Lý do cụ thể: redis.module.ts nạp RateLimitService, còn service lại nạp
 * token từ module — vòng phụ thuộc. TypeScript biên dịch xong xuôi, nhưng lúc
 * chạy `@Inject(REDIS)` nhận `undefined` và Nest báo "can't resolve
 * dependencies of RateLimitService (?)", một thông báo không hề nhắc tới vòng
 * lặp. Tách token là cách gỡ chuẩn.
 *
 * DatabaseModule không dính vì không module nào nạp ngược TenantDb.
 */
export const REDIS = Symbol('REDIS');
