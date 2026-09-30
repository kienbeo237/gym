/**
 * CỔNG GÁC KHOÁ REDIS.
 *
 * Redis KHÔNG biết gì về RLS. Một khoá đặt tên `members:list` sẽ được phòng tập
 * vào sau đọc lại nguyên xi — rò dữ liệu qua đường cache, trong khi mọi truy vấn
 * CSDL vẫn hoàn toàn đúng. Lớp lỗi này không để lại vết: không lỗi, không log,
 * chỉ là số liệu của phòng khác hiện trên màn hình người dùng.
 *
 * Quét mã nguồn là cách duy nhất bắt được trước khi nó lên môi trường thật.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { globalKey, tenantKey } from '../src/redis/redis-keys';

const SRC = join(__dirname, '..', 'src');

/** Chỉ những tệp này (đều trong src/redis/) được chạm thẳng vào client Redis. */
const DUOC_DUNG_REDIS_THO = [
  'redis/redis.tokens.ts',
  'redis/redis.module.ts',
  'redis/rate-limit.service.ts',
  // Không tự dựng khoá: bên gọi truyền khoá từ tenantKey()/globalKey().
  'redis/ephemeral-store.service.ts',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function codeLines(file: string): { no: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text, i) => ({ no: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

const FILES = walk(SRC).map((f) => ({ abs: f, rel: relative(SRC, f).split(sep).join('/') }));

describe('Không gian tên khoá Redis', () => {
  it('có quét được mã nguồn (chống test rỗng)', () => {
    expect(FILES.length).toBeGreaterThan(10);
  });

  it('chỉ module redis được tiêm client Redis thô', () => {
    const viPham: string[] = [];
    for (const f of FILES) {
      if (DUOC_DUNG_REDIS_THO.includes(f.rel)) continue;
      for (const { no, text } of codeLines(f.abs)) {
        if (/\bREDIS\b/.test(text) && !text.includes('RedisModule')) {
          viPham.push(`${f.rel}:${no}  ${text.trim()}`);
        }
      }
    }
    expect(
      viPham,
      `Dùng client Redis thô nghĩa là tự dựng khoá, và khoá thiếu tiền tố tenant\n` +
        `là rò dữ liệu qua cache. Đi qua RateLimitService, hoặc thêm một service\n` +
        `mới trong src/redis/ dùng tenantKey()/globalKey():\n${viPham.join('\n')}`,
    ).toEqual([]);
  });

  it('không nơi nào dựng khoá Redis bằng chuỗi ghép thủ công', () => {
    const viPham: string[] = [];
    for (const f of FILES) {
      if (DUOC_DUNG_REDIS_THO.includes(f.rel)) continue;
      for (const { no, text } of codeLines(f.abs)) {
        // Bắt lời gọi lệnh Redis nhận thẳng chuỗi/template thay vì kết quả của
        // tenantKey()/globalKey().
        //
        // Neo vào TÊN BIẾN nhận (`redis`/`client`), không chỉ vào tên phương
        // thức: `.get(` trần bắt cả `cfg.get('S3_REGION')` và hàng chục lời gọi
        // vô can khác — bộ nhận diện kêu oan liên tục thì người ta sẽ tắt nó đi,
        // và cổng gác mất tác dụng hoàn toàn.
        if (/\b(redis|client)\.(get|set|del|incr|expire|hset|hget|sadd|zadd)\(\s*[`'"]/.test(text)) {
          viPham.push(`${f.rel}:${no}  ${text.trim()}`);
        }
      }
    }
    expect(
      viPham,
      `Khoá Redis phải dựng bằng tenantKey() hoặc globalKey():\n${viPham.join('\n')}`,
    ).toEqual([]);
  });
});

describe('redis-keys: hành vi', () => {
  const T = '11111111-2222-3333-4444-555555555555';

  it('tenantKey gắn tiền tố t:<uuid>:', () => {
    expect(tenantKey(T, 'members', 'list')).toBe(`t:${T}:members:list`);
  });

  it('globalKey gắn tiền tố g:', () => {
    expect(globalKey('otp', 'req', 'abc')).toBe('g:otp:req:abc');
  });

  it('tenantKey TỪ CHỐI giá trị không phải uuid', () => {
    // Đây là ca thật: `tenantKey(ctx.tenantId, ...)` với ctx undefined sẽ tạo
    // khoá 't:undefined:...' mà MỌI phòng tập cùng dùng chung — một cache rò
    // hoàn hảo, không lỗi ở đâu cả.
    expect(() => tenantKey('undefined', 'x')).toThrow(/uuid/);
    expect(() => tenantKey('', 'x')).toThrow(/uuid/);
    expect(() => tenantKey(undefined as unknown as string, 'x')).toThrow(/uuid/);
  });

  it('từ chối đoạn khoá rỗng hoặc có dấu cách', () => {
    expect(() => globalKey('otp', '')).toThrow();
    expect(() => tenantKey(T, 'a b')).toThrow();
  });

  it('bộ nhận diện KHÔNG rỗng: mẫu xấu bị bắt', () => {
    // Test âm. Ghép chuỗi để chính tệp này không tự báo mình nếu về sau nó bị
    // đưa vào phạm vi quét.
    const RE = /\b(redis|client)\.(get|set|del|incr|expire|hset|hget|sadd|zadd)\(\s*[`'"]/;

    const mauXau = ['redis', '.get(', '`members:${id}`', ')'].join('');
    expect(RE.test(mauXau)).toBe(true);

    const mauTot = 'redis.get(tenantKey(id, "members"))';
    expect(RE.test(mauTot)).toBe(false);

    // Phải KHÔNG bắt lời gọi vô can — nếu không, bộ nhận diện kêu oan và
    // người ta sẽ vô hiệu hoá nó.
    expect(RE.test("cfg.get('S3_REGION')")).toBe(false);
    expect(RE.test("this.cfg.get('NODE_ENV')")).toBe(false);
  });
});
