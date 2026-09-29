/**
 * CỔNG GÁC KỶ LUẬT TRUY CẬP CSDL.
 *
 * RLS chỉ bảo vệ được khi mọi truy vấn nghiệp vụ đi qua đúng một cửa: TenantDb,
 * chạy bằng role app_rw. Có ba cách vô hiệu hoá nó, cả ba đều trông vô hại
 * trong pull request:
 *
 *   1. tiêm DB_PLATFORM (BYPASSRLS) vào service nghiệp vụ "cho nhanh"
 *   2. tiêm DB_APP thẳng, bỏ qua bước set_config -> query trả 0 dòng, người sửa
 *      lại tưởng "mất dữ liệu" và đi thêm điều kiện lung tung
 *   3. dùng `SET` thay cho set_config(..., TRUE) -> ngữ cảnh sống hết đời KẾT
 *      NỐI và rò sang request của tenant khác
 *
 * Quét mã nguồn là cách duy nhất bắt được cả ba trước khi chúng lên môi trường
 * thật. Test này cố ý KHÔNG có danh sách miễn trừ: ngoại lệ phải nằm ở đúng
 * tệp được phép, chứ không nằm trong một mảng ai cũng thêm được một dòng.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', 'src');

/** Chỉ những tệp này được chạm vào kết nối bỏ qua RLS. */
const DUOC_DUNG_DB_PLATFORM = ['db/database.module.ts'];
/** Chỉ luồng đăng nhập (chạy trước khi có tenant) được dùng app_auth. */
const DUOC_DUNG_DB_AUTH = ['db/database.module.ts', 'auth/auth.service.ts'];
/** Chỉ TenantDb được cầm Kysely thô — nó chính là cửa duy nhất. */
const DUOC_DUNG_DB_APP = [
  'db/database.module.ts',
  'common/tenant-db.service.ts',
  'health/health.controller.ts',   // chỉ chạy `SELECT 1`, không đọc dữ liệu nghiệp vụ
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Bỏ dòng comment thuần — mã đã sửa cố ý trích lại hình dạng cũ để giải thích. */
function codeLines(file: string): { no: number; text: string }[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text, i) => ({ no: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    });
}

const FILES = walk(SRC).map((f) => ({
  abs: f,
  rel: relative(SRC, f).split(sep).join('/'),
}));

describe('Kỷ luật truy cập CSDL', () => {
  it('có quét được mã nguồn (chống test rỗng)', () => {
    expect(FILES.length).toBeGreaterThan(8);
  });

  it.each([
    ['DB_PLATFORM', DUOC_DUNG_DB_PLATFORM, 'kết nối BYPASSRLS — nhìn xuyên mọi phòng tập'],
    ['DB_AUTH', DUOC_DUNG_DB_AUTH, 'kết nối BYPASSRLS của luồng đăng nhập'],
    ['DB_APP', DUOC_DUNG_DB_APP, 'Kysely thô, chưa đặt app.tenant_id'],
  ])('%s chỉ được dùng ở tệp được phép', (token, allowed, moTa) => {
    const viPham: string[] = [];
    for (const f of FILES) {
      if (allowed.includes(f.rel)) continue;
      for (const { no, text } of codeLines(f.abs)) {
        if (text.includes(token)) viPham.push(`${f.rel}:${no}  ${text.trim()}`);
      }
    }
    expect(
      viPham,
      `${token} là ${moTa}.\n` +
        `Service nghiệp vụ phải đi qua TenantDb.run(). Nếu thật sự cần ngoại lệ,\n` +
        `thêm tệp vào danh sách trong chính test này — để nó hiện ra trong review:\n` +
        viPham.join('\n'),
    ).toEqual([]);
  });

  it('không nơi nào đặt app.tenant_id bằng SET (phải là set_config LOCAL)', () => {
    const viPham: string[] = [];
    for (const f of FILES) {
      for (const { no, text } of codeLines(f.abs)) {
        // Bắt `SET app.tenant_id` và `set_config(...)` với tham số thứ ba false.
        if (/\bSET\s+app\.tenant_id/i.test(text)) {
          viPham.push(`${f.rel}:${no}  ${text.trim()}   <- SET sống hết đời KẾT NỐI`);
        }
        if (/set_config\s*\([^)]*false\s*\)/i.test(text)) {
          viPham.push(`${f.rel}:${no}  ${text.trim()}   <- tham số thứ ba phải là true`);
        }
      }
    }
    expect(
      viPham,
      `Ngữ cảnh tenant phải bị giới hạn trong transaction. Pool tái sử dụng kết\n` +
        `nối, nên biến sống lâu hơn transaction sẽ rò sang request của tenant khác\n` +
        `— không lỗi, không log, chỉ sai dữ liệu:\n${viPham.join('\n')}`,
    ).toEqual([]);
  });

  it('bộ nhận diện KHÔNG rỗng: một vi phạm giả lập bị bắt', () => {
    // Test âm. Dùng chuỗi GHÉP để chính tệp này không tự báo mình — nó nằm
    // ngoài src/ nên không bị quét, nhưng giữ thói quen đó cho chắc.
    const mauXau = ['await tx.query("', 'SET ', 'app.tenant_id = x")'].join('');
    expect(/\bSET\s+app\.tenant_id/i.test(mauXau)).toBe(true);

    const mauTot = "set_config('app.tenant_id', id, true)";
    expect(/set_config\s*\([^)]*false\s*\)/i.test(mauTot)).toBe(false);
  });
});
