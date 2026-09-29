/**
 * Migration runner — chỉ tiến, không lùi.
 *
 * Vì sao tự viết thay vì dùng công cụ sẵn: schema này dùng RLS policy, khoá
 * ngoại ghép, EXCLUDE USING gist, partial unique index và cột GENERATED. Không
 * công cụ sinh-SQL-từ-model nào diễn đạt được chúng, nên SQL là nguồn sự thật
 * và thứ cần duy nhất là một bộ chạy tuần tự có khoá và có checksum.
 *
 *   pnpm db:migrate    # áp các file chưa chạy
 *   pnpm db:status     # liệt kê trạng thái
 *
 * Ba bất biến:
 *   - Mỗi file chạy trong MỘT transaction. Lỗi giữa chừng là rollback trọn file.
 *   - Advisory lock: hai tiến trình deploy song song không dẫm lên nhau.
 *   - Checksum: sửa một file ĐÃ CHẠY sẽ bị chặn, vì trên môi trường khác nó đã
 *     chạy bản cũ và hai DB sẽ lệch nhau mà không ai biết.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import 'dotenv/config';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const LOCK_KEY = 4_071_991; // bất kỳ, miễn cố định

type Migration = { version: string; name: string; sql: string; checksum: string };

function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const version = file.split('_')[0] ?? file;
      return {
        version,
        name: file,
        sql,
        // sha256, không phải md5: quét SAST gắn cờ md5 kể cả khi chỉ dùng làm
        // vân tay nội dung, và không có lý do gì để chọn md5 ở đây.
        checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
      };
    });
}

async function ensureRegistry(db: Client) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     text PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms int NOT NULL
    )`);
}

async function connect(): Promise<Client> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu DATABASE_URL (xem .env.example)');
  const db = new Client({ connectionString: url });
  await db.connect();
  return db;
}

async function up() {
  const db = await connect();
  try {
    await ensureRegistry(db);
    await db.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);

    const applied = new Map<string, string>(
      (await db.query<{ version: string; checksum: string }>(
        'SELECT version, checksum FROM schema_migrations',
      )).rows.map((r) => [r.version, r.checksum]),
    );

    let ran = 0;
    for (const m of loadMigrations()) {
      const prev = applied.get(m.version);
      if (prev !== undefined) {
        if (prev !== m.checksum) {
          throw new Error(
            `Migration ${m.name} ĐÃ CHẠY nhưng nội dung đã đổi (${prev} -> ${m.checksum}).\n` +
              `Không sửa file đã chạy — tạo file mới. Môi trường khác đã áp bản cũ.`,
          );
        }
        continue;
      }
      process.stdout.write(`  -> ${m.name} ... `);
      const t0 = Date.now();
      try {
        await db.query('BEGIN');
        await db.query(m.sql);
        await db.query(
          'INSERT INTO schema_migrations (version, name, checksum, duration_ms) VALUES ($1,$2,$3,$4)',
          [m.version, m.name, m.checksum, Date.now() - t0],
        );
        await db.query('COMMIT');
      } catch (e) {
        await db.query('ROLLBACK');
        process.stdout.write('LỖI\n');
        throw e;
      }
      process.stdout.write(`${Date.now() - t0}ms\n`);
      ran++;
    }
    console.log(ran === 0 ? 'Không có migration mới.' : `Đã áp ${ran} migration.`);
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    await db.end();
  }
}

async function status() {
  const db = await connect();
  try {
    await ensureRegistry(db);
    const applied = new Map(
      (await db.query<{ version: string; applied_at: Date }>(
        'SELECT version, applied_at FROM schema_migrations',
      )).rows.map((r) => [r.version, r.applied_at]),
    );
    for (const m of loadMigrations()) {
      const at = applied.get(m.version);
      console.log(`${at ? 'DA CHAY ' : 'CHO    '} ${m.name}${at ? `  (${at.toISOString()})` : ''}`);
    }
  } finally {
    await db.end();
  }
}

const cmd = process.argv[2] ?? 'up';
const run = cmd === 'status' ? status : up;
run().catch((e: unknown) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
