/**
 * Batch D: báo phát ZNS qua webhook của Zalo, SMS dự phòng cho OTP.
 *
 * Cùng cách dựng với phase9-self-service.spec.ts: service thật trên MỘT kết nối
 * đang mở transaction ngoài, transaction của Kysely thành SAVEPOINT, đóng vai
 * app_rw (luồng OTP: app_auth) nên RLS / quyền cột áp như API thật.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import type { ConfigService } from '@nestjs/config';
import type { DB } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { niemPhong } from '../src/common/secret-box';
import { assertCauHinhSanSang } from '../src/common/config-guard';
import { ZaloWebhookService } from '../src/zalo/zalo-webhook.service';
import { ZaloApi } from '../src/zalo/zalo-api';
import type { ZaloOaService } from '../src/zalo/zalo-oa.service';
import { OutboxDispatcher } from '../src/notification/outbox-dispatcher.service';
import { SmsApi, khongDau } from '../src/sms/sms-api';
import { OtpService } from '../src/auth/otp.service';
import type { RateLimitService } from '../src/redis/rate-limit.service';

config({ path: resolve(__dirname, '../../../.env') });
// CI không có .env: khoá gốc chỉ để niêm phong/mở secret OA TRONG test này.
process.env.TENANT_SECRET_KEY ||= 'test-only-master-key-not-a-secret-0000000';

function savepointKysely(c: Client): Kysely<DB> {
  let n = 0;
  const stack: string[] = [];
  const conn = {
    query: async (text: string, params?: unknown[]) => {
      const t = text.trim().toLowerCase();
      if (t === 'begin') {
        const sp = `sp_${++n}`;
        stack.push(sp);
        return c.query(`SAVEPOINT ${sp}`);
      }
      if (t === 'commit') return c.query(`RELEASE SAVEPOINT ${stack.pop()}`);
      if (t === 'rollback') {
        const sp = stack.pop();
        await c.query(`ROLLBACK TO SAVEPOINT ${sp}`);
        return c.query(`RELEASE SAVEPOINT ${sp}`);
      }
      return c.query(text, params as unknown[]);
    },
    release: () => {},
  };
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool: { connect: async () => conn, end: async () => {} } as never }),
  });
}

/** ConfigService giả: đọc process.env, cho phép ghi đè từng khoá trong một test. */
const env: Record<string, string | undefined> = {};
const cfg = {
  get: (k: string) => (k in env ? env[k] : process.env[k]),
  getOrThrow: (k: string) => {
    const v = k in env ? env[k] : process.env[k];
    if (!v) throw new Error(`thiếu ${k}`);
    return v;
  },
} as unknown as ConfigService;

let c: Client;
let tenantA: string;
let tenantB: string;
let master: string;

let webhook: ZaloWebhookService;
let disp: OutboxDispatcher;
let sms: SmsApi;
let otp: OtpService;
const daGuiSms: { phone: string; text: string }[] = [];

const APP_ID = '5550001112223';
const KHOA_WH = 'oa-webhook-secret-test';

const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

/** Làm việc với quyền chủ CSDL trong chốc lát (dựng dữ liệu vượt RLS), rồi trả vai cũ. */
async function voiQuyenChu<T>(fn: () => Promise<T>, vaiSau = 'app_rw'): Promise<T> {
  await q('RESET ROLE');
  try {
    return await fn();
  } finally {
    await q(`SET LOCAL ROLE ${vaiSau}`);
  }
}

async function loi(p: Promise<unknown>): Promise<number> {
  try {
    await p;
  } catch (e) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? 500;
  }
  throw new Error('Mong có lỗi nhưng không');
}

const ky = (than: string, ts: string, khoa = KHOA_WH, app = APP_ID) =>
  `mac=${createHash('sha256').update(app + than + ts + khoa).digest('hex')}`;

function suKien(msg: Record<string, unknown>, ts = '1700000000000', event = 'user_received_message') {
  return JSON.stringify({ event_name: event, app_id: APP_ID, timestamp: ts, sender: { id: 'oa-1' }, message: msg });
}

async function themTin(v: {
  tenant?: string;
  channel?: string;
  template?: string;
  status?: string;
  msgId?: string | null;
  payload?: Record<string, unknown>;
  key?: string;
  attempts?: number;
}): Promise<string> {
  const r = await q<{ id: string }>(
    `INSERT INTO notification_outbox (tenant_id, channel, template_code, recipient_ref, idempotency_key, status, provider_msg_id, payload, attempts)
     VALUES ($1, $2, $3, '+84901999888', $4, $5, $6, $7, $8) RETURNING id`,
    [
      v.tenant ?? tenantA,
      v.channel ?? 'ZALO_ZNS',
      v.template ?? 'CHECKIN_REMAINING',
      v.key ?? `TEST:${Math.random()}`,
      v.status ?? 'SENT',
      v.msgId ?? null,
      JSON.stringify(v.payload ?? {}),
      v.attempts ?? 0,
    ],
  );
  return String(r.rows[0]!.id);
}

const xuLy = (tenant: string, id: string) =>
  (disp as unknown as { xuLy: (t: string, i: string) => Promise<void> }).xuLy(tenant, id);

const tin = async (id: string) =>
  (
    await q<{ status: string; channel: string; last_error: string | null; payload: Record<string, unknown>; delivered_at: Date | null }>(
      `SELECT status, channel, last_error, payload, delivered_at FROM notification_outbox WHERE id = $1`,
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 2`);
  if (t.rows.length < 2) throw new Error('Cần dữ liệu seed hai phòng. Chạy: pnpm db:seed');
  tenantA = t.rows[0]!.id;
  tenantB = t.rows[1]!.id;
  master = process.env.TENANT_SECRET_KEY!;

  const db = savepointKysely(c);
  const tdb = new TenantDb(db);
  webhook = new ZaloWebhookService(tdb, cfg);
  sms = new SmsApi(cfg);
  const guiThat = sms.send.bind(sms);
  sms.send = async (a) => {
    daGuiSms.push({ phone: a.phone, text: a.text });
    return guiThat(a);
  };
  // OA không bao giờ được gọi trong các ca ở đây (mẫu chưa duyệt -> dừng trước).
  disp = new OutboxDispatcher(tdb, new ZaloApi(cfg), {} as ZaloOaService, cfg, sms);
  const rate = { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }), reset: async () => {} } as unknown as RateLimitService;
  otp = new OtpService(db, rate, cfg, sms);
});

afterAll(async () => {
  await c.end().catch(() => {});
});

beforeEach(async () => {
  for (const k of Object.keys(env)) delete env[k];
  env.SMS_DRIVER = 'log';
  daGuiSms.length = 0;
  await c.query('BEGIN');
  // Dựng OA của phòng A với khoá webhook đã biết (ghi đè cấu hình dev nếu có).
  await q(
    `INSERT INTO tenant_zalo_oa (tenant_id, app_id, secret_enc, webhook_secret_enc, status)
     VALUES ($1, $2, $3, $4, 'DISCONNECTED')
     ON CONFLICT (tenant_id) DO UPDATE SET app_id = EXCLUDED.app_id, webhook_secret_enc = EXCLUDED.webhook_secret_enc`,
    [tenantA, APP_ID, niemPhong(master, tenantA, 'zalo.secret', 'app-secret'), niemPhong(master, tenantA, 'zalo.webhook', KHOA_WH)],
  );
  await q(`DELETE FROM tenant_zalo_oa WHERE tenant_id = $1`, [tenantB]);
  await c.query('SET LOCAL ROLE app_rw');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
});
afterEach(async () => {
  await c.query('ROLLBACK');
});

describe('Webhook báo phát ZNS', () => {
  it('khớp theo tracking_id: ghi delivered_at theo giờ Zalo báo, KHÔNG đổi trạng thái; gửi lại = ALREADY', async () => {
    const id = await themTin({ msgId: 'zmsg-1' });
    const than = suKien({ msg_id: 'zmsg-1', tracking_id: id, delivery_time: '1700000000500' });
    const r = await webhook.nhan(tenantA, Buffer.from(than), ky(than, '1700000000000'));
    expect(r.outcome).toBe('DELIVERED');
    const t = await tin(id);
    expect(t.status).toBe('SENT');
    expect(new Date(t.delivered_at!).getTime()).toBe(1700000000500);

    const lai = await webhook.nhan(tenantA, Buffer.from(than), ky(than, '1700000000000'));
    expect(lai.outcome).toBe('ALREADY_DELIVERED');
  });

  it('khớp theo msg_id khi không có tracking_id; báo phát tới TRƯỚC khi worker ghi SENT vẫn nhận', async () => {
    const id = await themTin({ msgId: 'zmsg-2', status: 'SENDING' });
    const than = suKien({ msg_id: 'zmsg-2', delivery_time: '1700000001000' });
    expect((await webhook.nhan(tenantA, Buffer.from(than), ky(than, '1700000000000'))).outcome).toBe('DELIVERED');
    expect((await tin(id)).status).toBe('SENDING');
  });

  it('chữ ký sai / thân bị sửa / app_id khác -> 401, không ghi gì', async () => {
    const id = await themTin({ msgId: 'zmsg-3' });
    const than = suKien({ msg_id: 'zmsg-3', tracking_id: id });
    expect(await loi(webhook.nhan(tenantA, Buffer.from(than), ky(than, '1700000000000', 'khoa-sai-hoan-toan')))).toBe(401);
    expect(await loi(webhook.nhan(tenantA, Buffer.from(than), undefined))).toBe(401);
    const sua = than.replace('zmsg-3', 'zmsg-X');
    expect(await loi(webhook.nhan(tenantA, Buffer.from(sua), ky(than, '1700000000000')))).toBe(401);
    const appKhac = JSON.stringify({ ...JSON.parse(than), app_id: '999' });
    expect(await loi(webhook.nhan(tenantA, Buffer.from(appKhac), ky(appKhac, '1700000000000')))).toBe(401);
    expect((await tin(id)).delivered_at).toBeNull();
  });

  it('phòng chưa khai khoá webhook -> 404; phòng không tồn tại -> 404', async () => {
    const than = suKien({ msg_id: 'x' });
    expect(await loi(webhook.nhan(tenantB, Buffer.from(than), ky(than, '1700000000000')))).toBe(404);
    expect(await loi(webhook.nhan('00000000-0000-4000-8000-000000000000', Buffer.from(than), ky(than, '1700000000000')))).toBe(404);
  });

  it('KHÔNG khớp được tin của phòng khác qua URL của phòng mình (RLS)', async () => {
    const idB = await voiQuyenChu(() => themTin({ tenant: tenantB, msgId: 'zmsg-B' }));
    const than = suKien({ msg_id: 'zmsg-B', tracking_id: idB });
    expect((await webhook.nhan(tenantA, Buffer.from(than), ky(than, '1700000000000'))).outcome).toBe('UNMATCHED');
    const b = await voiQuyenChu(() => q<{ delivered_at: Date | null }>(`SELECT delivered_at FROM notification_outbox WHERE id = $1`, [idB]));
    expect(b.rows[0]!.delivered_at).toBeNull();
  });

  it('sự kiện khác -> IGNORED; không có mã nào -> UNMATCHED; JSON hỏng -> 400', async () => {
    const khac = suKien({ msg_id: 'zmsg-1' }, '1700000000000', 'user_send_text');
    expect((await webhook.nhan(tenantA, Buffer.from(khac), ky(khac, '1700000000000'))).outcome).toBe('IGNORED');
    const rong = suKien({});
    expect((await webhook.nhan(tenantA, Buffer.from(rong), ky(rong, '1700000000000'))).outcome).toBe('UNMATCHED');
    expect(await loi(webhook.nhan(tenantA, Buffer.from('{hong'), ky('{hong', '')))).toBe(400);
  });
});

describe('SMS dự phòng cho OTP', () => {
  const otpZns = async (ma: string, han = Date.now() + 300_000) => {
    const codeEnc = niemPhong(master, tenantA, 'otp.code', ma).toString('base64');
    return themTin({
      template: 'OTP_LOGIN',
      status: 'SENDING',
      attempts: 1,
      key: `OTP:test-${ma}`,
      payload: { codeEnc, expiresAt: new Date(han).toISOString() },
    });
  };
  // Mẫu OTP chưa duyệt -> worker dừng trước khi gọi Zalo, đúng ca "Zalo không gửi được".
  const boDuyetOtp = () => voiQuyenChu(() => q(`DELETE FROM tenant_zns_template WHERE tenant_id = $1 AND template_code = 'OTP_LOGIN'`, [tenantA]));

  it('Zalo không gửi được -> dòng Zalo kết thúc (mã bị xoá), dòng SMS mang mã sang; SMS gửi đúng mã, không dấu', async () => {
    await boDuyetOtp();
    const id = await otpZns('482913');
    await xuLy(tenantA, id);

    const z = await tin(id);
    expect(z.status).toBe('SKIPPED');
    expect(z.last_error).toMatch(/^TEMPLATE_NOT_APPROVED.*đã chuyển sang SMS$/);
    expect(z.payload.codeEnc).toBeUndefined();

    const s = (
      await q<{ id: string; status: string; payload: Record<string, unknown> }>(
        `SELECT id, status, payload FROM notification_outbox WHERE idempotency_key = 'OTP:test-482913:SMS'`,
      )
    ).rows[0]!;
    expect(s.status).toBe('PENDING');
    expect(typeof s.payload.codeEnc).toBe('string');

    await q(`UPDATE notification_outbox SET status = 'SENDING', attempts = 1 WHERE id = $1`, [s.id]);
    await xuLy(tenantA, String(s.id));
    const sau = await tin(String(s.id));
    expect(sau.status).toBe('SENT');
    expect(sau.channel).toBe('SMS');
    expect(sau.payload.codeEnc).toBeUndefined();
    expect(daGuiSms).toHaveLength(1);
    expect(daGuiSms[0]!.phone).toBe('+84901999888');
    expect(daGuiSms[0]!.text).toContain('482913');
    expect(daGuiSms[0]!.text).toMatch(/^[\x20-\x7E]+$/);

    const dem = await q<{ sent_count: number }>(
      `SELECT sent_count FROM tenant_message_usage WHERE tenant_id = $1 AND channel = 'SMS'
        AND period_month = date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
      [tenantA],
    );
    expect(dem.rows[0]!.sent_count).toBeGreaterThanOrEqual(1);
  });

  it('SMS tắt (SMS_DRIVER=off) -> không sinh dòng SMS, lý do giữ nguyên', async () => {
    env.SMS_DRIVER = 'off';
    await boDuyetOtp();
    const id = await otpZns('111222');
    await xuLy(tenantA, id);
    expect((await tin(id)).last_error).toMatch(/^TEMPLATE_NOT_APPROVED/);
    expect((await tin(id)).last_error).not.toMatch(/SMS/);
    const n = await q(`SELECT 1 FROM notification_outbox WHERE idempotency_key = 'OTP:test-111222:SMS'`);
    expect(n.rowCount).toBe(0);
  });

  it('mã đã hết hạn -> không chuyển SMS (gửi bây giờ là gửi mã chết)', async () => {
    await boDuyetOtp();
    const id = await otpZns('333444', Date.now() - 1000);
    await xuLy(tenantA, id);
    expect((await tin(id)).last_error).toMatch(/^EXPIRED/);
    const n = await q(`SELECT 1 FROM notification_outbox WHERE idempotency_key = 'OTP:test-333444:SMS'`);
    expect(n.rowCount).toBe(0);
  });

  it('tin chăm sóc qua SMS -> SKIPPED SMS_TEMPLATE_UNSUPPORTED (không tự tốn tiền SMS)', async () => {
    const id = await themTin({ channel: 'SMS', template: 'PACKAGE_EXPIRING', status: 'SENDING', attempts: 1 });
    await xuLy(tenantA, id);
    expect((await tin(id)).status).toBe('SKIPPED');
    expect((await tin(id)).last_error).toMatch(/^SMS_TEMPLATE_UNSUPPORTED/);
    expect(daGuiSms).toHaveLength(0);
  });

  it('yêu cầu OTP khi không phòng nào gửi được Zalo -> xếp thẳng dòng SMS; SMS tắt -> không xếp gì', async () => {
    const { rows } = await voiQuyenChu(() =>
      q<{ phone: string }>(
        `SELECT i.phone FROM identity i JOIN tenant_user tu ON tu.identity_id = i.id
          WHERE tu.tenant_id = $1 AND tu.role = 'MEMBER' AND tu.status = 'ACTIVE' AND i.status = 'ACTIVE' LIMIT 1`,
        [tenantA],
      ),
    );
    const phone = rows[0]!.phone;
    // Không phòng nào có OA đang kết nối.
    await voiQuyenChu(() => q(`UPDATE tenant_zalo_oa SET status = 'DISCONNECTED'`), 'app_auth');

    const r = await otp.request(phone);
    expect(r.devCode).toMatch(/^\d{6}$/);
    const o = await voiQuyenChu(
      () =>
        q<{ channel: string; payload: Record<string, unknown> }>(
          `SELECT channel, payload FROM notification_outbox WHERE recipient_ref = $1 AND template_code = 'OTP_LOGIN'
            ORDER BY id DESC LIMIT 1`,
          [phone],
        ),
      'app_auth',
    );
    expect(o.rows[0]!.channel).toBe('SMS');
    expect(typeof o.rows[0]!.payload.codeEnc).toBe('string');

    env.SMS_DRIVER = 'off';
    const truoc = await voiQuyenChu(() => q(`SELECT 1 FROM notification_outbox WHERE recipient_ref = $1`, [phone]), 'app_auth');
    // Qua giới hạn "một phút một lần" của Redis: rate đã được giả ở trên.
    await otp.request(phone);
    const sau = await voiQuyenChu(() => q(`SELECT 1 FROM notification_outbox WHERE recipient_ref = $1`, [phone]), 'app_auth');
    expect(sau.rowCount).toBe(truoc.rowCount);
  });

  it('config-guard chặn SMS_DRIVER=log ở production (log chứa mã OTP thô)', () => {
    const that = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'a'.repeat(48),
      JWT_REFRESH_SECRET: 'b'.repeat(48),
      TENANT_SECRET_KEY: 'c'.repeat(44),
      DATABASE_URL_APP: 'postgres://app_rw:S3cret!@db/pt',
      DATABASE_URL_AUTH: 'postgres://app_auth:S3cret!@db/pt',
      DATABASE_URL_PLATFORM: 'postgres://app_platform:S3cret!@db/pt',
      S3_SECRET_KEY: 'd'.repeat(40),
      REDIS_PASSWORD: 'e'.repeat(24),
    };
    expect(() => assertCauHinhSanSang(that)).not.toThrow();
    expect(() => assertCauHinhSanSang({ ...that, SMS_DRIVER: 'log' })).toThrow('CONFIG_NOT_PRODUCTION_READY');
    expect(() => assertCauHinhSanSang({ ...that, SMS_DRIVER: 'off' })).not.toThrow();
  });

  it('khongDau: bỏ dấu, đ -> d, bỏ ký tự ngoài ASCII in được', () => {
    expect(khongDau('Phòng Đà Nẵng — Gym 🏋')).toBe('Phong Da Nang  Gym ');
  });
});
