/**
 * Vá kiểu sinh ra cho các cột `date`.
 *
 * VẤN ĐỀ: kysely-codegen ánh xạ cả `date` lẫn `timestamptz` về cùng một alias
 * `Timestamp = ColumnType<Date, ...>`. Nhưng từ migration phase 2, ứng dụng đặt
 * `types.setTypeParser(DATE, v => v)` để cột `date` giữ nguyên chuỗi
 * 'YYYY-MM-DD' — vì để node-postgres dựng nó thành `Date` là tự tạo ra lỗi lệch
 * một ngày (xem chú thích ở database.module.ts).
 *
 * Hậu quả nếu không vá: hệ thống kiểu NÓI SAI SỰ THẬT. Nó bảo `period_month` là
 * `Date` trong khi lúc chạy là `string`, nên:
 *   - truyền chuỗi vào `.where('period_month', '=', '2026-09-01')` bị BÁO LỖI
 *     dù đó chính là thứ đúng
 *   - gọi `.toISOString()` trên giá trị đọc ra thì biên dịch XANH và vỡ lúc chạy
 *
 * Cả hai chiều đều sai, và chiều thứ hai sai im lặng.
 *
 * CÁCH VÁ: hỏi thẳng CSDL cột nào là `date`, rồi đổi đúng những cột đó sang
 * `DateString`. Chính xác và tất định — không đoán theo tên cột.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import 'dotenv/config';

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'contracts', 'src', 'db.ts');

const KHAI_BAO = `
/**
 * Cột \`date\` của Postgres: một ngày trên tờ lịch, KHÔNG phải một thời điểm.
 * Ứng dụng đặt setTypeParser để nó giữ nguyên chuỗi 'YYYY-MM-DD' — đừng gọi
 * \`new Date(...)\` lên nó rồi \`.toISOString()\`, sẽ lùi một ngày ở múi giờ +07.
 */
export type DateString = ColumnType<string, string, string>;
`;

async function main(): Promise<void> {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();

  // Lấy CẢ bảng lẫn view/matview — báo cáo đọc qua view bọc.
  const { rows } = await db.query<{ tbl: string; col: string }>(`
    SELECT c.table_name AS tbl, c.column_name AS col
    FROM information_schema.columns c
    JOIN pg_class k ON k.relname = c.table_name
    JOIN pg_namespace n ON n.oid = k.relnamespace AND n.nspname = 'public'
    WHERE c.table_schema = 'public' AND c.data_type = 'date'`);
  await db.end();

  const theoBang = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!theoBang.has(r.tbl)) theoBang.set(r.tbl, new Set());
    theoBang.get(r.tbl)!.add(r.col);
  }

  const src = readFileSync(FILE, 'utf8');
  const dong = src.split(/\r?\n/);

  // `snake_case` -> `PascalCase`, đúng quy ước đặt tên của kysely-codegen.
  const pascal = (s: string) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  const bangCuaInterface = new Map([...theoBang.keys()].map((t) => [pascal(t), t]));

  let bangHienTai: string | null = null;
  let daVa = 0;

  for (let i = 0; i < dong.length; i++) {
    const mo = /^export interface (\w+)/.exec(dong[i]!);
    if (mo) {
      bangHienTai = bangCuaInterface.get(mo[1]!) ?? null;
      continue;
    }
    if (dong[i] === '}') { bangHienTai = null; continue; }
    if (!bangHienTai) continue;

    const cot = /^\s{2}(\w+):\s*(.+);$/.exec(dong[i]!);
    if (!cot || !theoBang.get(bangHienTai)!.has(cot[1]!)) continue;

    const kieuMoi = cot[2]!.replace(/\bTimestamp\b/g, 'DateString');
    if (kieuMoi !== cot[2]) {
      dong[i] = `  ${cot[1]}: ${kieuMoi};`;
      daVa++;
    }
  }

  let out = dong.join('\n');
  if (!out.includes('export type DateString')) {
    out = out.replace(
      /export type Timestamp = .*;\n/,
      (m) => m + KHAI_BAO,
    );
  }
  writeFileSync(FILE, out);
  console.log(`Đã vá ${daVa} cột date sang DateString.`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
