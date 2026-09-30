/**
 * Kiểm thử tải API — không phụ thuộc gói nào (Node >= 20, fetch sẵn có).
 *
 *   pnpm loadtest:seed && pnpm loadtest
 *   LT_VUS=100 LT_DURATION=120 LT_BASE=https://staging.example.vn/api pnpm loadtest
 *
 * Kịch bản: LT_VUS người dùng ảo chạy song song, mỗi người là MỘT hội viên đã
 * đăng nhập (đăng nhập mật khẩu -> chọn phòng loadtest), lặp theo trọng số:
 *
 *   30%  GET  /me/summary            màn chính app hội viên
 *   20%  GET  /bookings?from&to      lịch 30 ngày quanh hôm nay
 *   15%  GET  /bookings/slots        khung trống 7 ngày (nặng nhất phía đọc)
 *   10%  GET  /me/ledger             lịch sử buổi
 *   10%  POST /bookings + /cancel    ghi: đặt một khung trống rồi huỷ (ngoài khung huỷ muộn -> không trừ buổi)
 *   15%  chủ phòng: /members?q, /reports/dashboard, /bookings trong ngày
 *
 * TRAINER_BUSY / MEMBER_BUSY khi đặt là tranh chấp THẬT giữa người dùng ảo (hai
 * người chọn cùng khung) — đếm riêng là "tranh chấp", không tính là lỗi.
 *
 * Kết quả: số lượt, lỗi, p50/p95/p99/max từng loại + tổng. Thoát mã 1 nếu tỉ lệ
 * lỗi > LT_MAX_ERROR_RATE (mặc định 0.01) hoặc p95 tổng > LT_P95_MS (mặc định 500).
 *
 * Đo ở máy dev chỉ cho số tương đối (API, Postgres, Redis và máy tạo tải chung
 * một CPU). Số để quyết định cấu hình máy thật phải đo từ máy KHÁC vào staging.
 */
const BASE = process.env.LT_BASE ?? 'http://localhost:4000/api';
const VUS = Number(process.env.LT_VUS ?? 30);
const DURATION = Number(process.env.LT_DURATION ?? 60) * 1000;
const PASSWORD = process.env.LT_PASSWORD ?? 'Matkhau@123';
const MEMBERS = Number(process.env.LT_MEMBERS ?? 300);
const P95_MS = Number(process.env.LT_P95_MS ?? 500);
const MAX_ERR = Number(process.env.LT_MAX_ERROR_RATE ?? 0.01);
const THINK_MS = Number(process.env.LT_THINK_MS ?? 0);

const so = (dau, i) => `+84${dau}${String(i).padStart(5, '0')}`;
const vnHomNay = () => new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10);
const cong = (d, n) => new Date(Date.parse(d) + n * 86400e3).toISOString().slice(0, 10);
const ngauNhien = (a) => a[Math.floor(Math.random() * a.length)];
const ngu = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- đo ------------------------------------------------------------------
const mau = new Map(); // tên -> { ms: number[], loi: number, tranhChap: number, ma: Map }
function ghi(ten, ms, ok, ma, tranhChap = false) {
  let m = mau.get(ten);
  if (!m) mau.set(ten, (m = { ms: [], loi: 0, tranhChap: 0, ma: new Map() }));
  m.ms.push(ms);
  if (tranhChap) m.tranhChap++;
  else if (!ok) {
    m.loi++;
    m.ma.set(ma, (m.ma.get(ma) ?? 0) + 1);
  }
}
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0);

async function goi(ten, tok, method, path, body, { tranhChap = [] } = {}) {
  const t = performance.now();
  let s = 0, j = null;
  try {
    const r = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    s = r.status;
    const txt = await r.text();
    try { j = JSON.parse(txt); } catch { j = txt; }
  } catch (e) {
    j = { code: `NET:${e.cause?.code ?? e.message}` };
  }
  const ms = performance.now() - t;
  const ok = s >= 200 && s < 300;
  const ma = j?.code ?? String(s);
  ghi(ten, ms, ok, ma, !ok && tranhChap.includes(ma));
  return { s, j, ok };
}

// ---- đăng nhập -------------------------------------------------------------
async function dangNhap(phone) {
  const post = async (p, body, h = {}) => {
    const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${phone} ${p}: ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const t = performance.now();
  const a = await post('/auth/login', { phone, password: PASSWORD });
  const phong = a.tenants.find((x) => x.slug === 'loadtest') ?? a.tenants[0];
  const s = await post('/auth/select-tenant', { tenantId: phong.tenantId }, { authorization: `Bearer ${a.preToken}` });
  ghi('auth: login + select-tenant', performance.now() - t, true);
  return s.accessToken;
}

async function chaySongSong(viec, n) {
  const kq = new Array(viec.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < viec.length) { const k = i++; kq[k] = await viec[k](); }
  }));
  return kq;
}

// ---- kịch bản --------------------------------------------------------------
async function vongHoiVien(u) {
  const r = Math.random();
  const hom = vnHomNay();
  if (r < 0.30) {
    const s = await goi('GET /me/summary', u.tok, 'GET', '/me/summary');
    if (s.ok && !u.mp) u.mp = s.j.packages?.[0]?.id;
  } else if (r < 0.50) {
    await goi('GET /bookings (30 ngày)', u.tok, 'GET', `/bookings?from=${cong(hom, -15)}&to=${cong(hom, 15)}`);
  } else if (r < 0.65) {
    if (u.mp) await goi('GET /bookings/slots', u.tok, 'GET', `/bookings/slots?memberPackageId=${u.mp}&from=${cong(hom, 2)}&days=7`);
  } else if (r < 0.75) {
    await goi('GET /me/ledger', u.tok, 'GET', '/me/ledger');
  } else if (r < 0.85) {
    if (!u.mp) return;
    const sl = await goi('GET /bookings/slots', u.tok, 'GET', `/bookings/slots?memberPackageId=${u.mp}&from=${cong(hom, 2)}&days=7`);
    const trong = sl.ok ? sl.j.days.flatMap((d) => d.slots) : [];
    if (!trong.length) return;
    const dat = await goi('POST /bookings', u.tok, 'POST', '/bookings', { memberPackageId: u.mp, startsAt: ngauNhien(trong).startsAt }, {
      tranhChap: ['TRAINER_BUSY', 'MEMBER_BUSY', 'NO_SESSION_LEFT'],
    });
    if (dat.ok) await goi('POST /bookings/:id/cancel', u.tok, 'POST', `/bookings/${dat.j.id}/cancel`, { reason: 'kiểm thử tải', by: 'MEMBER' });
  }
}

async function vongChuPhong(tok) {
  const r = Math.random();
  const hom = vnHomNay();
  if (r < 0.4) await goi('OWNER GET /members?q', tok, 'GET', `/members?q=${encodeURIComponent('tải ' + (1 + Math.floor(Math.random() * 30)))}&page=1&size=20`);
  else if (r < 0.7) await goi('OWNER GET /bookings (ngày)', tok, 'GET', `/bookings?from=${hom}&to=${hom}`);
  else await goi('OWNER GET /reports/dashboard', tok, 'GET', `/reports/dashboard?month=${hom.slice(0, 7)}`);
}

// ---- chạy ------------------------------------------------------------------
const soHoiVien = Math.min(VUS, MEMBERS);
console.log(`Đích ${BASE} · ${VUS} người dùng ảo · ${DURATION / 1000}s · đăng nhập ${soHoiVien} hội viên + chủ phòng…`);
const chu = await dangNhap('+84970000000');
const toks = await chaySongSong(Array.from({ length: soHoiVien }, (_, i) => () => dangNhap(so('9720', i))), 10);
const nguoi = Array.from({ length: VUS }, (_, i) => ({ tok: toks[i % toks.length], mp: undefined }));

const batDau = performance.now();
const het = batDau + DURATION;
let luot = 0;
await Promise.all(
  nguoi.map(async (u) => {
    while (performance.now() < het) {
      if (Math.random() < 0.15) await vongChuPhong(chu);
      else await vongHoiVien(u);
      luot++;
      if (THINK_MS) await ngu(THINK_MS * (0.5 + Math.random()));
    }
  }),
);
const giay = (performance.now() - batDau) / 1000;

// ---- báo cáo ---------------------------------------------------------------
const hang = [];
const tatCa = [];
let tongLoi = 0, tongTranh = 0, tongLuot = 0;
for (const [ten, m] of [...mau.entries()].sort()) {
  const s = m.ms.sort((a, b) => a - b);
  if (!ten.startsWith('auth')) { tatCa.push(...s); tongLoi += m.loi; tongTranh += m.tranhChap; tongLuot += s.length; }
  hang.push({
    'loại': ten,
    'lượt': s.length,
    'lỗi': m.loi,
    'tranh chấp': m.tranhChap,
    p50: Math.round(pct(s, 50)),
    p95: Math.round(pct(s, 95)),
    p99: Math.round(pct(s, 99)),
    max: Math.round(s[s.length - 1] ?? 0),
    'mã lỗi': [...m.ma.entries()].map(([k, v]) => `${k}×${v}`).join(' '),
  });
}
tatCa.sort((a, b) => a - b);
console.table(hang);
const tiLeLoi = tongLuot ? tongLoi / tongLuot : 0;
const p95 = pct(tatCa, 95);
console.log(
  `Tổng: ${tongLuot} request trong ${giay.toFixed(1)}s = ${(tongLuot / giay).toFixed(1)} req/s · ${luot} vòng · ` +
    `p50 ${Math.round(pct(tatCa, 50))} ms · p95 ${Math.round(p95)} ms · p99 ${Math.round(pct(tatCa, 99))} ms · ` +
    `lỗi ${(tiLeLoi * 100).toFixed(2)}% · tranh chấp ${tongTranh}`,
);
const dat = tiLeLoi <= MAX_ERR && p95 <= P95_MS;
console.log(dat ? `ĐẠT (lỗi ≤ ${MAX_ERR * 100}%, p95 ≤ ${P95_MS} ms)` : `KHÔNG ĐẠT (ngưỡng: lỗi ≤ ${MAX_ERR * 100}%, p95 ≤ ${P95_MS} ms)`);
process.exit(dat ? 0 : 1);
