/**
 * Sao lưu CSDL tự động — chạy thành dịch vụ `backup` trong docker-compose.prod.yml.
 *
 *   tsx db/backup.ts daemon             chạy mãi: sao lưu hằng ngày lúc BACKUP_TIME
 *   tsx db/backup.ts once               sao lưu ngay MỘT lần (cùng quy trình với daemon)
 *   tsx db/backup.ts predeploy          dump cục bộ nếu có migration ĐANG CHỜ (deploy.sh gọi)
 *   tsx db/backup.ts verify <tệp.dump>  khôi phục thử vào một cụm Postgres tạm, so số dòng
 *   tsx db/backup.ts list               liệt kê bản trên S3
 *   tsx db/backup.ts fetch <key> <ra>   tải một bản từ S3, kiểm sha256, giải mã
 *   tsx db/backup.ts decrypt <vào> <ra> giải mã một tệp .dump.enc
 *   tsx db/backup.ts status             in trạng thái; exit 1 nếu bản gần nhất quá cũ
 *
 * Một lần sao lưu:
 *   1. Mở giao dịch REPEATABLE READ, xuất snapshot, ĐẾM dòng từng bảng trong
 *      snapshot đó, rồi `pg_dump --snapshot` — tệp dump và con số đếm là của
 *      CÙNG một thời điểm, nên khôi phục thử so khớp được từng bảng.
 *   2. `pg_restore --list` — tệp đọc được và có dữ liệu.
 *   3. Mã hoá AES-256-GCM (BACKUP_ENCRYPTION_KEY) rồi tải lên S3 cùng tệp kê
 *      khai (.json: sha256, số dòng, phiên bản schema — không có dữ liệu).
 *   4. Xoay vòng: cục bộ giữ BACKUP_KEEP_LOCAL bản; S3 giữ mỗi ngày trong
 *      BACKUP_KEEP_DAILY ngày gần nhất + bản cuối mỗi tháng trong
 *      BACKUP_KEEP_MONTHLY tháng.
 *   5. Mỗi BACKUP_VERIFY_EVERY_DAYS ngày: khôi phục thử THẬT vào cụm tạm.
 *
 * Bản cục bộ KHÔNG mã hoá: nó nằm cạnh chính CSDL (cùng mức lộ), và là đường
 * cứu nhanh nhất khi còn máy. Bản đi ra ngoài máy thì luôn mã hoá — bucket có
 * thể bị cấu hình công khai nhầm, còn dump chứa số điện thoại hội viên.
 *
 * Lỗi -> gửi BACKUP_ALERT_WEBHOOK (nếu có), ghi status.json, healthcheck đỏ.
 * Thành công -> GET BACKUP_HEARTBEAT_URL (nếu có) để dịch vụ ngoài biết còn sống.
 */
import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import pg from 'pg';
import 'dotenv/config';

// ---- cấu hình -----------------------------------------------------------------
const env = (k: string, d = '') => (process.env[k] ?? '').trim() || d;
const num = (k: string, d: number) => {
  const v = Number(env(k, String(d)));
  if (!Number.isFinite(v) || v < 0) throw new Error(`${k} phải là số >= 0`);
  return v;
};

const DIR = path.resolve(env('BACKUP_DIR', './backups'));
const TIME = env('BACKUP_TIME', '02:30');
const KEEP_LOCAL = Math.max(1, num('BACKUP_KEEP_LOCAL', 7));
const KEEP_PREDEPLOY = 3;
const KEEP_DAILY = Math.max(1, num('BACKUP_KEEP_DAILY', 14));
const KEEP_MONTHLY = num('BACKUP_KEEP_MONTHLY', 12);
const VERIFY_EVERY_DAYS = num('BACKUP_VERIFY_EVERY_DAYS', 7);
const MAX_AGE_HOURS = num('BACKUP_MAX_AGE_HOURS', 26);
const ALERT_WEBHOOK = env('BACKUP_ALERT_WEBHOOK');
const HEARTBEAT_URL = env('BACKUP_HEARTBEAT_URL');
const LABEL = env('BACKUP_LABEL', env('DOMAIN', os.hostname()));
const S3_ON = env('BACKUP_S3', '1') !== '0';
const PREFIX = (() => {
  const p = env('BACKUP_S3_PREFIX', 'backups/pt/').replace(/^\/+/, '');
  return p && !p.endsWith('/') ? `${p}/` : p;
})();

const STATUS = path.join(DIR, 'status.json');
/** Healthcheck của compose chỉ nhìn mtime tệp này — không phải chạy node. */
const OK_MARK = path.join(DIR, '.ok');

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/**
 * Trong container tiến trình chạy bằng root (để khôi phục thử đổi được sang
 * user postgres). Trả mọi tệp về chủ của BACKUP_DIR — tức user deploy trên máy
 * chủ — để người vận hành đọc/scp bản sao lưu không cần sudo.
 */
function giaoChu(f: string) {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return;
  try {
    const st = fs.statSync(DIR);
    fs.chownSync(f, st.uid, st.gid);
  } catch {
    /* không đổi được chủ: tệp vẫn đọc được bằng sudo */
  }
}
function ghi(f: string, data: string) {
  fs.writeFileSync(f, data, { mode: 0o600 });
  giaoChu(f);
}

// ---- tên tệp ------------------------------------------------------------------
/** pt-20260930-0230.dump — giờ ĐỊA PHƯƠNG (TZ của tiến trình), sắp theo chữ = theo thời gian. */
export function tenBan(d: Date, loai: 'pt' | 'predeploy' = 'pt') {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${loai}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
const MAU_BAN = /^pt-(\d{8})-(\d{6})\.(dump\.enc|json)$/;

// ---- chạy lệnh ngoài ----------------------------------------------------------
/**
 * Thư mục chứa pg_dump/initdb… Alpine đặt bản thật ở /usr/libexec/postgresqlNN;
 * PG_BIN ghi đè (máy dev Windows trỏ vào bộ nhị phân tải về).
 */
function pgBin(ten: string) {
  const exe = process.platform === 'win32' ? `${ten}.exe` : ten;
  for (const d of [env('PG_BIN'), '/usr/libexec/postgresql17', '/usr/libexec/postgresql']) {
    if (d && fs.existsSync(path.join(d, exe))) return path.join(d, exe);
  }
  return ten;
}

interface ChayOpts {
  env?: NodeJS.ProcessEnv;
  uid?: number;
  gid?: number;
  /**
   * Không nối ống stdout/stderr. Cho `pg_ctl start`: tiến trình postgres con
   * THỪA KẾ các ống đó (Windows), nên 'close' không bao giờ tới. Đầu ra đã
   * nằm trong tệp -l.
   */
  noPipe?: boolean;
}
function chay(cmd: string, args: string[], o: ChayOpts = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(pgBin(cmd), args, {
      env: { ...process.env, ...o.env },
      uid: o.uid,
      gid: o.gid,
      stdio: o.noPipe ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    p.stdout?.on('data', (b: Buffer) => (out += b.toString()));
    p.stderr?.on('data', (b: Buffer) => {
      err = (err + b.toString()).slice(-4000);
    });
    p.on('error', reject);
    p.on(o.noPipe ? 'exit' : 'close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${cmd} thoát mã ${code}: ${err.trim().split('\n').slice(-6).join(' | ')}`)),
    );
  });
}

/** Biến PG* cho pg_dump — mật khẩu đi qua môi trường, không nằm trên dòng lệnh (`ps`). */
function pgEnv(url: string): NodeJS.ProcessEnv {
  const u = new URL(url);
  return {
    PGHOST: u.hostname,
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password),
    PGDATABASE: u.pathname.replace(/^\//, '') || 'postgres',
  };
}
const dbUrl = () => {
  const u = env('DATABASE_URL');
  if (!u) throw new Error('Thiếu DATABASE_URL (role chủ schema — pt_migrator)');
  return u;
};

// ---- mã hoá -------------------------------------------------------------------
// Định dạng: "PTBK1" | 8 byte vân tay khoá | 12 byte IV | bản mã | 16 byte tag GCM.
const MAGIC = Buffer.from('PTBK1');
const HEADER = MAGIC.length + 8 + 12;

function khoa(): Buffer {
  const hex = env('BACKUP_ENCRYPTION_KEY');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('BACKUP_ENCRYPTION_KEY phải là 64 ký tự hex (openssl rand -hex 32)');
  }
  return Buffer.from(hex, 'hex');
}
const vanTay = (k: Buffer) => createHash('sha256').update(k).digest().subarray(0, 8);

export async function maHoa(vao: string, ra: string, k = khoa()) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const out = fs.createWriteStream(ra, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, vanTay(k), iv]));
  await pipeline(fs.createReadStream(vao), c, out, { end: false });
  await new Promise<void>((res, rej) => out.end(c.getAuthTag(), () => res()).on('error', rej));
}

export async function giaiMa(vao: string, ra: string, k = khoa()) {
  const size = fs.statSync(vao).size;
  if (size < HEADER + 16) throw new Error(`${vao}: quá ngắn, không phải bản sao lưu mã hoá`);
  const fd = fs.openSync(vao, 'r');
  const head = Buffer.alloc(HEADER);
  const tag = Buffer.alloc(16);
  fs.readSync(fd, head, 0, HEADER, 0);
  fs.readSync(fd, tag, 0, 16, size - 16);
  fs.closeSync(fd);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${vao}: sai định dạng`);
  if (!head.subarray(MAGIC.length, MAGIC.length + 8).equals(vanTay(k))) {
    throw new Error(
      `${vao}: được mã hoá bằng khoá KHÁC (vân tay ${head.subarray(5, 13).toString('hex')}, ` +
        `khoá hiện tại ${vanTay(k).toString('hex')})`,
    );
  }
  const d = createDecipheriv('aes-256-gcm', k, head.subarray(MAGIC.length + 8));
  d.setAuthTag(tag);
  const tmp = `${ra}.partial`;
  // Tag chỉ được kiểm ở final(): ghi ra tệp tạm, chỉ đổi tên khi xác thực xong
  // — tệp bị sửa không bao giờ xuất hiện dưới tên thật.
  try {
    await pipeline(
      fs.createReadStream(vao, { start: HEADER, end: size - 17 }),
      d,
      fs.createWriteStream(tmp, { mode: 0o600 }),
    );
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${vao}: giải mã thất bại — tệp bị sửa/cụt (${(e as Error).message})`);
  }
  fs.renameSync(tmp, ra);
}

async function sha256(file: string) {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

// ---- S3 -----------------------------------------------------------------------
/** BACKUP_S3_* ghi đè S3_* — nên dùng bucket/khoá RIÊNG để API bị chiếm không xoá được bản sao lưu. */
function s3cfg() {
  const g = (k: string) => env(`BACKUP_${k}`) || env(k);
  const bucket = g('S3_BUCKET');
  const c = {
    bucket,
    client: new S3Client({
      region: g('S3_REGION') || 'us-east-1',
      endpoint: g('S3_ENDPOINT') || undefined,
      forcePathStyle: (g('S3_FORCE_PATH_STYLE') || 'true') === 'true',
      credentials: { accessKeyId: g('S3_ACCESS_KEY'), secretAccessKey: g('S3_SECRET_KEY') },
      // SDK mới mặc định gắn checksum CRC32 dạng aws-chunked — nhiều S3 tương
      // thích (Ceph, CMC…) từ chối. Chỉ tính khi thao tác BẮT BUỘC.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    }),
  };
  if (!bucket || !g('S3_ACCESS_KEY') || !g('S3_SECRET_KEY')) {
    throw new Error('Thiếu cấu hình S3 (BACKUP_S3_* hoặc S3_*) — hoặc đặt BACKUP_S3=0');
  }
  return c;
}

async function taiLen(file: string, key: string, type: string) {
  const { client, bucket } = s3cfg();
  const size = fs.statSync(file).size;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: fs.createReadStream(file),
      ContentLength: size,
      // Không gửi ACL: đối tượng mặc định đã riêng tư, và bucket tắt ACL
      // (mặc định mới của AWS) từ chối mọi header x-amz-acl.
      ContentType: type,
    }),
  );
  // Đọc lại: "PUT trả 200" chưa chắc là đủ byte.
  const h = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (h.ContentLength !== size) {
    throw new Error(`S3 ${key}: kích thước ${h.ContentLength} ≠ ${size}`);
  }
}

async function lietKeS3() {
  const { client, bucket } = s3cfg();
  const keys: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIX, ContinuationToken: token }),
    );
    for (const o of r.Contents ?? []) if (o.Key) keys.push({ key: o.Key, size: o.Size ?? 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Chọn bản S3 phải XOÁ. Hàm thuần — kiểm thử được không cần S3.
 *
 * Giữ: mọi bản trong KEEP_DAILY ngày (có bản) gần nhất; bản MỚI NHẤT của mỗi
 * tháng trong KEEP_MONTHLY tháng (có bản) gần nhất; và luôn giữ bản mới nhất.
 * Chỉ đụng tới khoá đúng mẫu tên do chính script này đặt — khoá lạ thì để yên.
 * Tệp .json đi cùng .dump.enc cùng tên gốc, nên giữ/xoá theo cặp.
 */
export function chonXoa(keys: string[], keepDaily: number, keepMonthly: number): string[] {
  const goc = new Map<string, string[]>(); // "pt-20260930-023000" -> các khoá
  for (const k of keys) {
    const m = MAU_BAN.exec(k.slice(PREFIX.length));
    if (!k.startsWith(PREFIX) || !m) continue;
    const g = `${m[1]}-${m[2]}`;
    goc.set(g, [...(goc.get(g) ?? []), k]);
  }
  // Chỉ bản có .dump.enc mới là "bản"; .json mồ côi (tải dump lỗi) xoá luôn.
  const ban = [...goc.keys()]
    .filter((g) => goc.get(g)!.some((k) => k.endsWith('.dump.enc')))
    .sort()
    .reverse();
  const giu = new Set<string>(ban.slice(0, 1));
  const ngay = [...new Set(ban.map((g) => g.slice(0, 8)))].slice(0, keepDaily);
  for (const g of ban) if (ngay.includes(g.slice(0, 8))) giu.add(g);
  const thang = new Set<string>();
  for (const g of ban) {
    const t = g.slice(0, 6);
    if (thang.has(t)) continue; // ban sắp giảm dần -> bản đầu tiên gặp là mới nhất của tháng
    if (thang.size >= keepMonthly) break;
    thang.add(t);
    giu.add(g);
  }
  return [...goc.entries()].filter(([g]) => !giu.has(g)).flatMap(([, ks]) => ks);
}

async function xoayVongS3() {
  const { client, bucket } = s3cfg();
  const xoa = chonXoa((await lietKeS3()).map((o) => o.key), KEEP_DAILY, KEEP_MONTHLY);
  // Từng khoá một: DeleteObjects bắt buộc Content-MD5/checksum mà S3 tương thích hay xử lý khác nhau.
  for (const key of xoa) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  if (xoa.length) log(`S3: xoá ${xoa.length} tệp cũ`);
}

function xoayVongCucBo(loai: 'pt' | 'predeploy', giu: number) {
  const re = new RegExp(`^${loai}-\\d{8}-\\d{6}\\.(dump|json)$`);
  const goc = [...new Set(fs.readdirSync(DIR).filter((f) => re.test(f)).map((f) => f.replace(/\.(dump|json)$/, '')))]
    .sort()
    .reverse();
  for (const g of goc.slice(giu)) {
    for (const ext of ['.dump', '.json']) fs.rmSync(path.join(DIR, g + ext), { force: true });
  }
}

// ---- trạng thái + cảnh báo ----------------------------------------------------
interface TrangThai {
  lastSuccessAt?: string;
  lastFile?: string;
  lastSize?: number;
  lastS3Key?: string | null;
  lastDurationMs?: number;
  lastVerifyAt?: string;
  lastVerify?: string;
  lastVerifyError?: string;
  lastErrorAt?: string;
  lastError?: string;
  consecutiveFailures?: number;
}
function docTrangThai(): TrangThai {
  try {
    return JSON.parse(fs.readFileSync(STATUS, 'utf8')) as TrangThai;
  } catch {
    return {};
  }
}
function ghiTrangThai(s: TrangThai) {
  ghi(`${STATUS}.tmp`, JSON.stringify(s, null, 2));
  fs.renameSync(`${STATUS}.tmp`, STATUS);
}

async function canhBao(msg: string) {
  const text = `[pt-backup ${LABEL}] ${msg}`;
  if (!ALERT_WEBHOOK) return;
  try {
    // `text` cho Slack/Google Chat/Mattermost, `content` cho Discord.
    const r = await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) log(`webhook cảnh báo trả ${r.status}`);
  } catch (e) {
    log('không gửi được cảnh báo:', (e as Error).message);
  }
}

// ---- dump ---------------------------------------------------------------------
interface KeKhai {
  file: string;
  createdAt: string;
  sha256: string;
  size: number;
  serverVersion: string;
  schemaVersion: string | null;
  rows: Record<string, number>;
  encrypted?: { sha256: string; size: number; keyFingerprint: string };
}

async function kiemPhienBan(c: pg.Client) {
  const srv = Number((await c.query<{ v: string }>(`SHOW server_version_num`)).rows[0].v);
  const out = await chay('pg_dump', ['--version']);
  const m = /(\d+)(?:\.(\d+))?/.exec(out);
  const dumpMajor = m ? Number(m[1]) : 0;
  if (dumpMajor < Math.floor(srv / 10000)) {
    throw new Error(
      `pg_dump ${dumpMajor} cũ hơn máy chủ ${Math.floor(srv / 10000)} — nâng gói postgresqlNN-client trong Dockerfile (stage tools)`,
    );
  }
  return String(srv);
}

/**
 * Dump + đếm dòng TRONG CÙNG snapshot. Kết nối `c` giữ giao dịch mở suốt lúc
 * pg_dump chạy — đóng sớm là snapshot biến mất và pg_dump báo lỗi.
 */
async function dump(file: string): Promise<KeKhai> {
  const url = dbUrl();
  const c = new pg.Client({ connectionString: url, application_name: 'pt-backup' });
  await c.connect();
  try {
    const serverVersion = await kiemPhienBan(c);
    // Migration đang giữ khoá độc quyền thì chờ tối đa 2 phút rồi báo lỗi (để
    // thử lại sau 30 phút), không treo vô hạn chặn luôn cả migration phía sau.
    await c.query(`SET lock_timeout = '120s'`);
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snap = (await c.query<{ s: string }>(`SELECT pg_export_snapshot() AS s`)).rows[0].s;
    const bang = (
      await c.query<{ t: string }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND n.nspname NOT LIKE 'pg_toast%'
          ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    const rows: Record<string, number> = {};
    for (const t of bang) {
      rows[t] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
    }
    const hasMig = bang.includes('public.schema_migrations');
    const schemaVersion = hasMig
      ? ((await c.query<{ v: string | null }>(`SELECT max(version) AS v FROM schema_migrations`)).rows[0].v ?? null)
      : null;

    const tmp = `${file}.partial`;
    await chay('pg_dump', ['-Fc', '-Z', '6', '--no-password', '--lock-wait-timeout=120s', `--snapshot=${snap}`, '-f', tmp], {
      env: pgEnv(url),
    });
    await c.query('COMMIT');
    fs.renameSync(tmp, file);
    fs.chmodSync(file, 0o600);
    giaoChu(file);

    // Đọc lại mục lục: tệp hỏng/cụt thì pg_restore từ chối ngay ở đây.
    const toc = await chay('pg_restore', ['--list', file]);
    const coDuLieu = (toc.match(/ TABLE DATA /g) ?? []).length;
    if (coDuLieu === 0 && Object.values(rows).some((n) => n > 0)) {
      throw new Error(`${file}: mục lục không có TABLE DATA nào`);
    }
    return {
      file: path.basename(file),
      createdAt: new Date().toISOString(),
      sha256: await sha256(file),
      size: fs.statSync(file).size,
      serverVersion,
      schemaVersion,
      rows,
    };
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    fs.rmSync(`${file}.partial`, { force: true });
    throw e;
  } finally {
    await c.end();
  }
}

/** Một lần sao lưu đầy đủ. Ném lỗi nếu BẤT KỲ bước nào hỏng. */
async function saoLuu(opts: { verify: boolean }) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  const goc = tenBan(new Date());
  const file = path.join(DIR, `${goc}.dump`);
  log(`bắt đầu ${goc}`);
  const kk = await dump(file);
  log(`dump xong ${(kk.size / 1048576).toFixed(1)} MB, ${Object.keys(kk.rows).length} bảng, schema ${kk.schemaVersion}`);

  let s3Key: string | null = null;
  if (S3_ON) {
    const k = khoa();
    const enc = `${file}.enc`;
    try {
      await maHoa(file, enc, k);
      kk.encrypted = { sha256: await sha256(enc), size: fs.statSync(enc).size, keyFingerprint: vanTay(k).toString('hex') };
      const kkFile = path.join(DIR, `${goc}.json`);
      ghi(kkFile, JSON.stringify(kk, null, 2));
      // Dump trước, kê khai sau: có .json trên S3 nghĩa là .dump.enc đã lên đủ.
      s3Key = `${PREFIX}${goc}.dump.enc`;
      await taiLen(enc, s3Key, 'application/octet-stream');
      await taiLen(kkFile, `${PREFIX}${goc}.json`, 'application/json');
      log(`đã tải lên s3://${s3cfg().bucket}/${s3Key}`);
    } finally {
      fs.rmSync(enc, { force: true });
    }
    await xoayVongS3();
  } else {
    ghi(path.join(DIR, `${goc}.json`), JSON.stringify(kk, null, 2));
  }
  xoayVongCucBo('pt', KEEP_LOCAL);

  const st = docTrangThai();
  const daLoi = (st.consecutiveFailures ?? 0) > 0;
  ghiTrangThai({
    ...st,
    lastSuccessAt: new Date().toISOString(),
    lastFile: path.basename(file),
    lastSize: kk.size,
    lastS3Key: s3Key,
    lastDurationMs: Date.now() - t0,
    consecutiveFailures: 0,
  });
  ghi(OK_MARK, new Date().toISOString());
  log(`xong ${goc} trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (daLoi) await canhBao(`Sao lưu đã chạy lại được: ${goc}${S3_ON ? '' : ' (KHÔNG chép ra S3)'}`);
  // "Công tắc người chết" (healthchecks.io, Uptime Kuma push…): dịch vụ bên
  // ngoài báo động khi KHÔNG nhận được nhịp — bắt cả trường hợp container này
  // chết hẳn, thứ mà webhook lỗi ở trên không bao giờ gửi được.
  if (HEARTBEAT_URL) {
    await fetch(HEARTBEAT_URL, { signal: AbortSignal.timeout(10_000) }).catch((e: Error) =>
      log('không gửi được nhịp:', e.message),
    );
  }

  // Khôi phục thử hỏng KHÔNG làm hỏng lần sao lưu (bản đã nằm trên S3), nhưng
  // cảnh báo riêng — và vì lastVerifyAt không đổi, ngày mai thử lại.
  const lanCuoi = st.lastVerifyAt ? Date.parse(st.lastVerifyAt) : 0;
  if (opts.verify && VERIFY_EVERY_DAYS > 0 && Date.now() - lanCuoi >= (VERIFY_EVERY_DAYS - 0.5) * 86400_000) {
    try {
      const tom = await khoiPhucThu(file, kk);
      ghiTrangThai({ ...docTrangThai(), lastVerifyAt: new Date().toISOString(), lastVerify: tom, lastVerifyError: undefined });
    } catch (e) {
      const msg = (e as Error).message;
      log('khôi phục thử LỖI:', msg);
      ghiTrangThai({ ...docTrangThai(), lastVerifyError: `${new Date().toISOString()} ${msg}` });
      await canhBao(`Khôi phục thử ${goc} LỖI — bản sao lưu có thể KHÔNG dùng được: ${msg}`);
    }
  }
}

// ---- khôi phục thử ------------------------------------------------------------
/** uid/gid của user `postgres` — initdb/postgres từ chối chạy bằng root. */
function nguoiPostgres(): { uid: number; gid: number } | undefined {
  if (process.platform === 'win32' || process.getuid?.() !== 0) return undefined;
  const dong = fs
    .readFileSync('/etc/passwd', 'utf8')
    .split('\n')
    .find((l) => l.startsWith('postgres:'));
  if (!dong) throw new Error('Không có user postgres để chạy cụm thử (cài gói postgresql17)');
  const [, , uid, gid] = dong.split(':');
  return { uid: Number(uid), gid: Number(gid) };
}

/**
 * Khôi phục `file` vào một cụm Postgres TẠM (initdb mới, cổng ngẫu nhiên chỉ
 * nghe 127.0.0.1, fsync tắt), rồi so số dòng từng bảng với kê khai lúc dump.
 * Không đụng tới CSDL thật. Trả về tóm tắt; ném lỗi nếu lệch.
 */
async function khoiPhucThu(file: string, kk?: KeKhai): Promise<string> {
  const t0 = Date.now();
  if (!kk) {
    const j = file.replace(/\.dump$/, '.json');
    if (fs.existsSync(j)) kk = JSON.parse(fs.readFileSync(j, 'utf8')) as KeKhai;
  }
  const u = nguoiPostgres();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-verify-'));
  const data = path.join(tmp, 'data');
  if (u) fs.chownSync(tmp, u.uid, u.gid);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const pw = randomBytes(16).toString('hex');
  const pwFile = path.join(tmp, 'pw');
  fs.writeFileSync(pwFile, pw, { mode: 0o600 });
  if (u) fs.chownSync(pwFile, u.uid, u.gid);
  let chayRoi = false;
  log(`khôi phục thử ${path.basename(file)} (cổng ${port})`);
  try {
    await chay('initdb', ['-D', data, '-U', 'postgres', '--pwfile', pwFile, '-A', 'scram-sha-256', '-E', 'UTF8', '--locale=C', '--no-sync'], u);
    const logFile = path.join(tmp, 'log');
    await chay(
      'pg_ctl',
      ['-D', data, '-l', logFile, '-w', '-t', '60', '-o',
        `-p ${port} -c listen_addresses=127.0.0.1 -c fsync=off -c full_page_writes=off -c synchronous_commit=off -c unix_socket_directories=`,
        'start'],
      { ...u, noPipe: true },
    ).catch((e: Error) => {
      const tail = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-5).join(' | ') : '';
      throw new Error(`${e.message} ${tail}`);
    });
    chayRoi = true;
    const conn = { host: '127.0.0.1', port, user: 'postgres', password: pw };
    const admin = new pg.Client({ ...conn, database: 'postgres' });
    await admin.connect();
    // Role là đối tượng CẤP CỤM, không nằm trong dump. Tạo đủ những role tệp
    // dump nhắc tới (chủ sở hữu + GRANT) để pg_restore không vấp.
    // Dò trên DDL: OWNER TO / GRANT … TO / REVOKE … FROM / CREATE POLICY … TO.
    // Bắt thừa một tên thì chỉ thừa một role NOLOGIN trong cụm sắp xoá.
    const roles = new Set(['pt_migrator', 'app_rw', 'app_auth', 'app_platform']);
    const ddl = await chay('pg_restore', ['-f', '-', '--schema-only', file]);
    for (const dong of ddl.split('\n')) {
      if (!/^(GRANT|REVOKE|ALTER|CREATE POLICY)\b/.test(dong)) continue;
      for (const m of dong.matchAll(/\b(?:TO|FROM|ROLE) ([a-z_][a-z0-9_]*)\b/g)) {
        if (m[1] !== 'postgres') roles.add(m[1]);
      }
    }
    for (const r of roles) {
      const co = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [r]);
      if (!co.rowCount) await admin.query(`CREATE ROLE ${pg.escapeIdentifier(r)} NOLOGIN${r === 'pt_migrator' ? ' BYPASSRLS' : ''}`);
    }
    await admin.query(`CREATE DATABASE pt OWNER pt_migrator`);
    await admin.end();

    await chay('pg_restore', ['--exit-on-error', '--no-password', '-j', '2', '-d', 'pt', file], {
      env: { PGHOST: '127.0.0.1', PGPORT: String(port), PGUSER: 'postgres', PGPASSWORD: pw },
    });

    const c = new pg.Client({ ...conn, database: 'pt' });
    await c.connect();
    const lech: string[] = [];
    let tong = 0;
    try {
      const bang = kk ? Object.keys(kk.rows) : [];
      for (const t of bang) {
        const n = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0].n);
        tong += n;
        if (n !== kk!.rows[t]) lech.push(`${t}: ${n} ≠ ${kk!.rows[t]}`);
      }
      const nTenant = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM tenant`)).rows[0].n);
      if (kk && (kk.rows['public.tenant'] ?? 0) > 0 && nTenant === 0) lech.push('tenant rỗng');
    } finally {
      await c.end();
    }
    if (lech.length) throw new Error(`khôi phục thử LỆCH số dòng: ${lech.slice(0, 5).join('; ')}`);
    const tom = `OK ${path.basename(file)}: ${kk ? Object.keys(kk.rows).length : '?'} bảng, ${tong} dòng khớp, ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    log(`khôi phục thử ${tom}`);
    return tom;
  } finally {
    if (chayRoi) await chay('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { ...u, noPipe: true }).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ---- predeploy ----------------------------------------------------------------
/**
 * Migration chỉ tiến, không có "down". Có migration CHỜ chạy thì chụp một bản
 * ngay trước — hỏng thì còn đường quay. Không có gì chờ (hoặc CSDL còn trống)
 * thì bỏ qua, để deploy thường không tốn thời gian dump.
 */
async function predeploy() {
  const c = new pg.Client({ connectionString: dbUrl() });
  await c.connect();
  let dangCho: string[] = [];
  try {
    const co = (await c.query(`SELECT to_regclass('public.schema_migrations') AS t`)).rows[0].t;
    if (!co) {
      log('CSDL chưa có schema_migrations — không có gì để sao lưu');
      return;
    }
    const daChay = new Set(
      (await c.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version),
    );
    const dir = path.join(__dirname, 'migrations');
    dangCho = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.split('_')[0])
      .filter((v) => !daChay.has(v));
  } finally {
    await c.end();
  }
  if (!dangCho.length) {
    log('không có migration chờ — bỏ qua bản predeploy');
    return;
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = path.join(DIR, `${tenBan(new Date(), 'predeploy')}.dump`);
  const kk = await dump(file);
  ghi(file.replace(/\.dump$/, '.json'), JSON.stringify(kk, null, 2));
  xoayVongCucBo('predeploy', KEEP_PREDEPLOY);
  log(`bản predeploy ${path.basename(file)} (${dangCho.length} migration chờ: ${dangCho.join(', ')})`);
}

// ---- daemon -------------------------------------------------------------------
export function lanToi(now: Date, hhmm: string): Date {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`BACKUP_TIME "${hhmm}" phải dạng HH:MM`);
  const t = new Date(now);
  t.setHours(Number(m[1]), Number(m[2]), 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

const ngu = (ms: number, sig: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    sig.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });

async function daemon() {
  // Hỏng cấu hình thì chết NGAY lúc khởi động (container restart-loop, deploy
  // thấy), không phải 02:30 sáng mai.
  if (S3_ON) {
    khoa();
    s3cfg();
  }
  lanToi(new Date(), TIME);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  for (const f of fs.readdirSync(DIR)) if (f.endsWith('.partial')) fs.rmSync(path.join(DIR, f), { force: true });

  const ac = new AbortController();
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.on(s, () => ac.abort());
  log(`daemon: hằng ngày lúc ${TIME} (TZ=${process.env.TZ ?? 'hệ thống'}), S3 ${S3_ON ? `bật, prefix ${PREFIX}` : 'TẮT'}`);

  // Khởi động lại (deploy, reboot) mà bản gần nhất đã quá một ngày -> chạy bù sau 1 phút.
  const st = docTrangThai();
  const cu = !st.lastSuccessAt || Date.now() - Date.parse(st.lastSuccessAt) > 24 * 3600_000;
  let next = cu ? new Date(Date.now() + 60_000) : lanToi(new Date(), TIME);
  let thuLai = 0;

  while (!ac.signal.aborted) {
    log(`lần tới: ${next.toString()}`);
    // setTimeout tối đa ~24.8 ngày; ngủ từng đoạn ngắn để đồng hồ máy đổi cũng không lệch nhiều.
    while (!ac.signal.aborted && Date.now() < next.getTime()) {
      await ngu(Math.min(next.getTime() - Date.now(), 300_000), ac.signal);
    }
    if (ac.signal.aborted) break;
    try {
      await saoLuu({ verify: true });
      thuLai = 0;
      next = lanToi(new Date(), TIME);
    } catch (e) {
      const msg = (e as Error).message;
      log('LỖI:', msg);
      const s = docTrangThai();
      const n = (s.consecutiveFailures ?? 0) + 1;
      ghiTrangThai({ ...s, lastErrorAt: new Date().toISOString(), lastError: msg, consecutiveFailures: n });
      await canhBao(`Sao lưu LỖI (lần ${n}): ${msg}`);
      // Thử lại 3 lần cách 30 phút, rồi chờ lịch hôm sau.
      thuLai++;
      next = thuLai <= 3 ? new Date(Date.now() + 30 * 60_000) : lanToi(new Date(), TIME);
      if (thuLai > 3) thuLai = 0;
    }
  }
  log('daemon dừng');
}

// ---- trạng thái ---------------------------------------------------------------
function inTrangThai(): number {
  const s = docTrangThai();
  console.log(JSON.stringify(s, null, 2));
  if (!s.lastSuccessAt) {
    console.error('Chưa có bản sao lưu thành công nào.');
    return 1;
  }
  const gio = (Date.now() - Date.parse(s.lastSuccessAt)) / 3600_000;
  if (gio > MAX_AGE_HOURS) {
    console.error(`Bản gần nhất đã ${gio.toFixed(1)} giờ (> ${MAX_AGE_HOURS}).`);
    return 1;
  }
  return 0;
}

// ---- main ---------------------------------------------------------------------
async function main() {
  const [cmd = 'daemon', a, b] = process.argv.slice(2);
  switch (cmd) {
    case 'daemon':
      return daemon();
    case 'once':
      try {
        return await saoLuu({ verify: env('BACKUP_VERIFY_NOW') === '1' });
      } catch (e) {
        const s = docTrangThai();
        ghiTrangThai({ ...s, lastErrorAt: new Date().toISOString(), lastError: (e as Error).message, consecutiveFailures: (s.consecutiveFailures ?? 0) + 1 });
        throw e;
      }
    case 'predeploy':
      return predeploy();
    case 'verify': {
      if (!a) throw new Error('verify <tệp.dump>');
      await khoiPhucThu(path.resolve(a));
      return;
    }
    case 'list':
      for (const o of await lietKeS3()) console.log(`${(o.size / 1048576).toFixed(1).padStart(8)} MB  ${o.key}`);
      return;
    case 'fetch': {
      if (!a || !b) throw new Error('fetch <key S3 của .dump.enc> <tệp ra .dump>');
      const { client, bucket } = s3cfg();
      const enc = `${b}.enc`;
      const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: a }));
      await pipeline(r.Body as Readable, fs.createWriteStream(enc, { mode: 0o600 }));
      try {
        const j = await client
          .send(new GetObjectCommand({ Bucket: bucket, Key: a.replace(/\.dump\.enc$/, '.json') }))
          .then(async (x) => JSON.parse(await x.Body!.transformToString()) as KeKhai)
          .catch(() => undefined);
        if (j?.encrypted && (await sha256(enc)) !== j.encrypted.sha256) throw new Error('sha256 tệp tải về không khớp kê khai');
        await giaiMa(enc, b);
        if (j && (await sha256(b)) !== j.sha256) throw new Error('sha256 sau giải mã không khớp kê khai');
        if (j) fs.writeFileSync(b.replace(/\.dump$/, '') + '.json', JSON.stringify(j, null, 2));
        log(`đã tải + giải mã -> ${b}${j ? ' (sha256 khớp kê khai)' : ''}`);
      } finally {
        fs.rmSync(enc, { force: true });
      }
      return;
    }
    case 'decrypt':
      if (!a || !b) throw new Error('decrypt <vào.dump.enc> <ra.dump>');
      return giaiMa(a, b);
    case 'status':
      process.exitCode = inTrangThai();
      return;
    default:
      throw new Error(`Lệnh lạ: ${cmd}`);
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(`\n${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
