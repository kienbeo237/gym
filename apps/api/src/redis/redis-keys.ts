/**
 * Mọi khoá Redis phải đi qua đây.
 *
 * Redis KHÔNG biết gì về RLS. Một khoá cache đặt tên `members:list` sẽ được
 * phòng tập vào sau đọc lại nguyên xi — rò dữ liệu qua đường cache, trong khi
 * mọi truy vấn CSDL vẫn hoàn toàn đúng. Lớp lỗi này không để lại vết ở đâu cả:
 * không lỗi, không log, chỉ là số liệu của phòng khác hiện trên màn hình.
 *
 * Hai không gian tên, không có cái thứ ba:
 *
 *   t:<tenantId>:...   dữ liệu THUỘC một phòng tập
 *   g:...              dữ liệu trước-khi-có-tenant (OTP, giới hạn tần suất theo
 *                      số điện thoại) hoặc của mặt phẳng nền tảng
 *
 * Cổng gác: test/redis-key-namespace.spec.ts quét mã nguồn và đỏ nếu có lời gọi
 * Redis nào dựng khoá không qua module này.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSegment(value: string, ten: string): void {
  if (!value || value.includes(' ')) {
    throw new Error(`Đoạn khoá Redis không hợp lệ (${ten}): ${JSON.stringify(value)}`);
  }
}

/** Khoá thuộc một phòng tập. tenantId phải là uuid thật, không phải chuỗi tuỳ ý. */
export function tenantKey(tenantId: string, ...parts: string[]): string {
  if (!UUID_RE.test(tenantId)) {
    // Chặn ngay ca `tenantKey(undefined as any, ...)` -> 't:undefined:...', một
    // khoá mà MỌI phòng tập cùng dùng chung.
    throw new Error(`tenantKey cần uuid, nhận: ${JSON.stringify(tenantId)}`);
  }
  parts.forEach((p, i) => assertSegment(p, `parts[${i}]`));
  return `t:${tenantId}:${parts.join(':')}`;
}

/** Khoá toàn cục: chỉ cho dữ liệu KHÔNG thuộc phòng tập nào. */
export function globalKey(...parts: string[]): string {
  parts.forEach((p, i) => assertSegment(p, `parts[${i}]`));
  return `g:${parts.join(':')}`;
}

/** Số điện thoại có dấu `+` và là dữ liệu cá nhân — băm trước khi làm khoá. */
export function phoneKeyPart(phone: string, hash: (s: string) => string): string {
  return hash(phone).slice(0, 24);
}
