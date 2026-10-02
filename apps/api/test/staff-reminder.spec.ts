/**
 * Nhắc lịch cho nhân viên + hộp thông báo (0024).
 *
 * Điều phải giữ:
 *  - HLV được nhắc ~30 phút trước buổi, một lần; dời giờ thì nhắc lại;
 *  - lịch dạy trong ngày chỉ gửi trong khung 7h–11h giờ VN, một lần / ngày;
 *  - buổi quá 10 phút chưa điểm danh: báo lễ tân (không có lễ tân thì chủ
 *    phòng + quản lý) và HLV của buổi; buổi quá cũ không báo;
 *  - chạy lặp không sinh trùng;
 *  - mỗi người chỉ đọc / đánh dấu thông báo của mình; nội dung không sửa được.
 *
 * Mốc thời gian đặt ở năm 2001 để không vướng lịch dev. Cùng cách dựng với
 * gift-sessions.spec.ts: service thật, đóng vai app_rw, mỗi test rollback.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import { Reflector } from '@nestjs/core';
import type { DB, TenantRole } from '@pt/contracts';
import { TenantDb } from '../src/common/tenant-db.service';
import { requestContext } from '../src/common/tenant-context';
import { ROLES } from '../src/common/auth.guard';
import { CommissionService } from '../src/commission/commission.service';
import { SaleService } from '../src/sale/sale.service';
import { StaffReminderService } from '../src/inbox/staff-reminder.service';
import { InboxService } from '../src/inbox/inbox.service';
import { InboxController } from '../src/inbox/inbox.controller';

config({ path: resolve(__dirname, '../../../.env') });

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

let c: Client;
let tenantA: string;
let owner: string;
let tdb: TenantDb;
let sale: SaleService;
let nhac: StaffReminderService;
let inbox: InboxService;
/** Một HLV đang ACTIVE ở phòng, cùng identity của họ. */
let hlv: { trainerId: string; identityId: string };

const q = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  c.query<R>(text, params);

const vai = <T>(who: { identityId: string; roles: TenantRole[] }, fn: () => Promise<T>) =>
  requestContext.run({ tenantId: tenantA, requestId: 'test', ...who }, fn);
const heThong = <T>(fn: () => Promise<T>) => vai({ identityId: '', roles: [] }, fn);

async function loi(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as { getStatus?: () => number; getResponse?: () => unknown };
    const body = err.getResponse?.() as { code?: string; message?: string } | string | undefined;
    return { status: err.getStatus?.() ?? 500, code: typeof body === 'object' ? (body.code ?? body.message) : body };
  }
  throw new Error('Mong có lỗi nhưng không');
}

async function sqlLoi(text: string, params: unknown[] = []): Promise<string> {
  await q('SAVEPOINT thu');
  try {
    await q(text, params);
  } catch (e) {
    await q('ROLLBACK TO SAVEPOINT thu');
    return (e as Error).message;
  }
  await q('RELEASE SAVEPOINT thu');
  throw new Error('Mong SQL vỡ nhưng không');
}

beforeAll(async () => {
  c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const t = await c.query<{ id: string }>(`SELECT id FROM tenant ORDER BY created_at LIMIT 1`);
  if (!t.rows[0]) throw new Error('Cần dữ liệu seed. Chạy: pnpm db:seed');
  tenantA = t.rows[0].id;
  owner = (
    await c.query<{ identity_id: string }>(
      `SELECT identity_id FROM tenant_user WHERE tenant_id = $1 AND role = 'OWNER' AND status = 'ACTIVE' LIMIT 1`,
      [tenantA],
    )
  ).rows[0]!.identity_id;
  const h = await c.query<{ id: string; identity_id: string }>(
    `SELECT tr.id, tr.identity_id FROM trainer tr
       JOIN tenant_user tu ON tu.tenant_id = tr.tenant_id AND tu.identity_id = tr.identity_id
      WHERE tr.tenant_id = $1 AND tr.status = 'ACTIVE' AND tu.role = 'PT' AND tu.status = 'ACTIVE'
      ORDER BY tr.code LIMIT 1`,
    [tenantA],
  );
  if (!h.rows[0]) throw new Error('Seed cần ít nhất một HLV có tài khoản PT');
  hlv = { trainerId: h.rows[0].id, identityId: h.rows[0].identity_id };

  tdb = new TenantDb(savepointKysely(c));
  sale = new SaleService(tdb, new CommissionService());
  nhac = new StaffReminderService(tdb);
  inbox = new InboxService(tdb);
});

afterAll(async () => {
  await c.end().catch(() => {});
});

beforeEach(async () => {
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE app_rw');
  await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
});
afterEach(async () => {
  await c.query('ROLLBACK');
});

/** 08:00 thứ Hai 05/03/2001 giờ VN. */
const T = new Date('2001-03-05T01:00:00Z');
const phut = (n: number) => new Date(T.getTime() + n * 60_000);

let goi: { memberId: string; packageId: string } | null = null;
/** Buổi ngắn 5 phút: một HLV không được có hai buổi chồng giờ (excl_booking_trainer_overlap). */
async function datBuoi(batDau: Date, phutDai = 5): Promise<string> {
  if (!goi) {
    const m = (await q<{ id: string }>(`SELECT id FROM member WHERE status = 'ACTIVE' ORDER BY code LIMIT 1`)).rows[0]!;
    const tpl = await q<{ id: string }>(
      `INSERT INTO package_template (tenant_id, code, name, kind, sessions, valid_days, price)
       VALUES ($1, 'TEST-NHAC-' || floor(random() * 1e9)::text, 'Gói thử nhắc lịch', 'PT', 20, 30, 2000000) RETURNING id`,
      [tenantA],
    );
    const ban = await vai({ identityId: owner, roles: ['OWNER'] }, () =>
      sale.sell({ memberId: m.id, templateId: tpl.rows[0]!.id, trainerId: hlv.trainerId, discount: 0, installments: [] }),
    );
    goi = { memberId: m.id, packageId: ban.memberPackageId };
  }
  const b = await q<{ id: string }>(
    `INSERT INTO booking (tenant_id, member_package_id, member_id, trainer_id, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $5::timestamptz + make_interval(mins => $6)) RETURNING id`,
    [tenantA, goi.packageId, goi.memberId, hlv.trainerId, batDau, phutDai],
  );
  return b.rows[0]!.id;
}
afterEach(() => {
  goi = null;
});

const thongBao = async (kind: string) =>
  (
    await q<{ identity_id: string; title: string; body: string; link: string | null; booking_id: string | null }>(
      `SELECT identity_id, title, body, link, booking_id FROM staff_notification WHERE kind = $1 ORDER BY identity_id`,
      [kind],
    )
  ).rows;

const quayLeTan = async () =>
  (
    await q<{ identity_id: string }>(
      `SELECT DISTINCT identity_id FROM tenant_user WHERE status = 'ACTIVE' AND role = 'RECEPTION'`,
    )
  ).rows.map((r) => r.identity_id);

describe('Nhắc HLV trước giờ dạy', () => {
  it('nhắc trong vòng 30 phút, một lần; buổi xa hơn / đã huỷ thì không', async () => {
    const gan = await datBuoi(phut(20));
    await datBuoi(phut(45));
    const huy = await datBuoi(phut(25));
    await q(`UPDATE booking SET status = 'CANCELLED_BY_STAFF', cancel_reason = 'thử' WHERE id = $1`, [huy]);

    const kq = await heThong(() => nhac.tick(T));
    expect(kq.upcoming).toBe(1);
    const ds = await thongBao('PT_UPCOMING');
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ identity_id: hlv.identityId, booking_id: gan, link: `/schedule/${gan}` });
    expect(ds[0]!.title).toBe('Sắp tới giờ dạy 08:20');

    expect((await heThong(() => nhac.tick(phut(3)))).upcoming).toBe(0);
    expect(await thongBao('PT_UPCOMING')).toHaveLength(1);
  });

  it('dời giờ thì nhắc lại theo giờ mới', async () => {
    const id = await datBuoi(phut(20));
    await heThong(() => nhac.tick(T));
    await q(`UPDATE booking SET starts_at = $2, ends_at = $2::timestamptz + interval '1 hour' WHERE id = $1`, [id, phut(50)]);
    expect((await heThong(() => nhac.tick(phut(25)))).upcoming).toBe(1);
    expect((await thongBao('PT_UPCOMING')).map((x) => x.title).sort()).toEqual([
      'Sắp tới giờ dạy 08:20',
      'Sắp tới giờ dạy 08:50',
    ]);
  });
});

describe('Lịch dạy trong ngày', () => {
  it('gửi một lần trong khung 7h–11h, liệt kê đủ buổi theo giờ', async () => {
    await datBuoi(phut(8 * 60)); // 16:00
    await datBuoi(phut(60)); // 09:00

    expect((await heThong(() => nhac.tick(phut(-90)))).agenda).toBe(0); // 06:30 — chưa tới giờ
    expect((await heThong(() => nhac.tick(T))).agenda).toBe(1);
    expect((await heThong(() => nhac.tick(phut(30)))).agenda).toBe(0);

    const ds = await thongBao('PT_AGENDA');
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ identity_id: hlv.identityId, link: '/schedule?view=day&date=2001-03-05' });
    expect(ds[0]!.title).toBe('Hôm nay bạn có 2 buổi dạy');
    expect(ds[0]!.body).toMatch(/^09:00 .+ · 16:00 /);
  });

  it('quá 11h mới chạy thì không gửi nữa', async () => {
    await datBuoi(phut(6 * 60));
    expect((await heThong(() => nhac.tick(phut(3 * 60 + 5)))).agenda).toBe(0);
  });
});

describe('Buổi quá giờ chưa điểm danh', () => {
  it('báo quầy + HLV của buổi; quá sớm hoặc quá cũ thì không', async () => {
    const tre = await datBuoi(phut(-15));
    await datBuoi(phut(-5)); // mới trễ 5 phút
    await datBuoi(phut(-180)); // trễ 3 tiếng — quá cũ

    await heThong(() => nhac.tick(T));
    const leTan = await quayLeTan();
    const quay = leTan.length
      ? leTan
      : (
          await q<{ identity_id: string }>(
            `SELECT DISTINCT identity_id FROM tenant_user WHERE status = 'ACTIVE' AND role IN ('OWNER', 'ADMIN')`,
          )
        ).rows.map((r) => r.identity_id);
    const ds = await thongBao('UNCHECKED');
    expect(ds.every((x) => x.booking_id === tre)).toBe(true);
    expect(ds.map((x) => x.identity_id).sort()).toEqual([...new Set([...quay, hlv.identityId])].sort());
    expect(ds[0]!.body).toContain('đã bắt đầu 15 phút');

    // 3 phút sau: buổi "-5" mới trễ 8 phút — chưa báo; buổi "-15" đã báo rồi.
    expect((await heThong(() => nhac.tick(phut(3)))).unchecked).toBe(0);
    // 5 phút sau: buổi "-5" đủ 10 phút trễ — giờ mới báo.
    expect((await heThong(() => nhac.tick(phut(5)))).unchecked).toBe(quay.length + (quay.includes(hlv.identityId) ? 0 : 1));
  });

  it('có lễ tân thì báo lễ tân, không làm phiền chủ phòng', async () => {
    // app_rw không tạo identity (bảng toàn cục) — mượn tạm vai pt_migrator.
    await q('RESET ROLE');
    const leTan = (
      await q<{ id: string }>(
        `INSERT INTO identity (phone, full_name) VALUES ('+849' || lpad(floor(random() * 1e8)::text, 8, '0'), 'Lễ tân thử') RETURNING id`,
      )
    ).rows[0]!.id;
    await q('SET LOCAL ROLE app_rw');
    await q(`INSERT INTO tenant_user (tenant_id, identity_id, role) VALUES ($1, $2, 'RECEPTION')`, [tenantA, leTan]);

    await datBuoi(phut(-20));
    await heThong(() => nhac.tick(T));
    const nhan = (await thongBao('UNCHECKED')).map((x) => x.identity_id);
    expect(nhan).toContain(leTan);
    expect(nhan).toContain(hlv.identityId);
    expect(nhan).not.toContain(owner);
  });
});

describe('Hộp thông báo', () => {
  it('chỉ nhân viên gọi được', () => {
    const r = new Reflector();
    for (const m of ['list', 'read', 'readAll'] as const) {
      const roles = r.get<TenantRole[]>(ROLES, InboxController.prototype[m] as () => unknown);
      expect([...roles].sort()).toEqual(['ADMIN', 'OWNER', 'PT', 'RECEPTION']);
    }
  });

  it('mỗi người chỉ thấy và đánh dấu được thông báo của mình', async () => {
    await datBuoi(phut(10));
    await datBuoi(phut(-15));
    await heThong(() => nhac.tick(T));

    const cuaHlv = await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.list());
    expect(cuaHlv.items.map((x) => x.kind).sort()).toEqual(['PT_AGENDA', 'PT_UPCOMING', 'UNCHECKED']);
    expect(cuaHlv.unread).toBe(3);

    // Chủ phòng không đánh dấu hộ được (404, không lộ là có tồn tại).
    const id = cuaHlv.items[0]!.id;
    expect(await loi(vai({ identityId: owner, roles: ['OWNER'] }, () => inbox.markRead(id)))).toMatchObject({
      status: 404,
      code: 'NOTIFICATION_NOT_FOUND',
    });

    await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.markRead(id));
    await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.markRead(id)); // lặp lại: không lỗi
    expect((await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.list())).unread).toBe(2);
    expect((await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.markAllRead())).updated).toBe(2);
    expect((await vai({ identityId: hlv.identityId, roles: ['PT'] }, () => inbox.list())).unread).toBe(0);
  });

  it('app_rw chỉ sửa được read_at, không sửa nội dung', async () => {
    await datBuoi(phut(10));
    await heThong(() => nhac.tick(T));
    expect(await sqlLoi(`UPDATE staff_notification SET title = 'sửa'`)).toMatch(/permission denied/);
    await q(`UPDATE staff_notification SET read_at = now()`);
  });
});
