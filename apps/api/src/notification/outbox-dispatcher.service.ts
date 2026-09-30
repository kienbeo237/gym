import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sql } from 'kysely';
import { TenantDb } from '../common/tenant-db.service';
import { moNiemPhong } from '../common/secret-box';
import { ZaloApi } from '../zalo/zalo-api';
import { ZaloOaService } from '../zalo/zalo-oa.service';
import { SmsApi, khongDau } from '../sms/sms-api';
import { MAU_TIN, laMaMau } from './templates';
import { MIEN_HAN_MUC, hanMucTinThang, hetHanMuc } from './quota';

/** Số lần thử tối đa, tính cả lần worker chết giữa chừng (attempts tăng lúc lấy việc). */
export const SO_LAN_TOI_DA = 5;
const LO = 50;
const LEASE_GIAY = 120;
/** Tin quá cũ thì không gửi nữa: "còn 5 buổi" của ba ngày trước là thông tin sai. */
const TUOI_TOI_DA_MS = 24 * 3600_000;

type KetThuc =
  | { status: 'SENT'; providerMsgId: string | null; channel: string }
  | { status: 'SKIPPED' | 'FAILED'; error: string }
  | { status: 'RETRY'; error: string };

/** Dòng SMS dự phòng cho một OTP không gửi được qua Zalo — ghi cùng transaction với kết quả. */
type DuPhong = { recipientRef: string; memberId: string | null; idempotencyKey: string; payload: Record<string, unknown> };

/**
 * Nội dung SMS theo mẫu. KHÔNG DẤU (xem khongDau). Chỉ OTP có bản SMS: tin chăm
 * sóc qua SMS tốn tiền theo từng tin, không phải thứ nên tự bật.
 */
function noiDungSms(templateCode: string, c: { gymName: string; secret?: string }): string | null {
  if (templateCode === 'OTP_LOGIN' && c.secret) {
    const phong = khongDau(c.gymName).trim().slice(0, 40) || 'PT Studio';
    return `${phong}: Ma dang nhap cua ban la ${c.secret}. Hieu luc 5 phut. Khong chia se ma nay cho bat ky ai.`;
  }
  return null;
}

/** Lùi dần: 30 giây, 2 phút, 8 phút, 32 phút. */
function lui(attempts: number): number {
  return 30_000 * 4 ** Math.max(0, attempts - 1);
}

/**
 * Worker gửi tin: lấy việc từ notification_outbox và giao cho kênh tương ứng.
 *
 * BA PHA cho mỗi tin, và pha giữa KHÔNG nằm trong transaction nào:
 *
 *   1. đọc   (runAs tenant)  dòng outbox + hội viên + ánh xạ mẫu
 *   2. gửi   (HTTP tới Zalo) có thể mất vài giây, có thể treo tới hết giờ chờ
 *   3. ghi   (runAs tenant)  kết quả — CHỈ khi dòng vẫn thuộc về lần lấy này
 *
 * "Vẫn thuộc về" = `attempts` còn bằng giá trị lúc đọc. Lease hết hạn trong lúc
 * đang gửi (Zalo treo lâu) thì worker khác có thể đã lấy lại dòng; nếu không
 * kiểm, hai worker sẽ ghi đè kết quả của nhau. Đây là fencing token.
 *
 * Bảo đảm là "ít nhất một lần", không phải "đúng một lần": worker chết SAU khi
 * Zalo nhận tin nhưng TRƯỚC pha 3 thì tin được gửi lại. Với tin nhắc lịch/số
 * buổi thì trùng một tin là chấp nhận được; mất tin thì không.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly log = new Logger(OutboxDispatcher.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly zalo: ZaloApi,
    private readonly oa: ZaloOaService,
    private readonly cfg: ConfigService,
    private readonly sms: SmsApi,
  ) {}

  /** Một nhịp: lấy một lô và xử lý. Trả về số tin đã lấy (lô đầy = còn việc). */
  async tick(): Promise<number> {
    const lo = await this.tdb.claimDueOutbox(LO, LEASE_GIAY);
    // Tuần tự trong từng phòng (tôn trọng hạn mức OA của họ), song song giữa các phòng.
    const theoPhong = new Map<string, string[]>();
    for (const v of lo) theoPhong.set(v.tenantId, [...(theoPhong.get(v.tenantId) ?? []), v.id]);

    await Promise.all(
      [...theoPhong].map(async ([tenantId, ids]) => {
        for (const id of ids) {
          try {
            await this.xuLy(tenantId, id);
          } catch (e) {
            // Lỗi lập trình / CSDL: để lease tự hết hạn, dòng sẽ quay lại hàng.
            this.log.error(`Tin #${id} (phòng ${tenantId}) lỗi ngoài dự kiến: ${String(e)}`);
          }
        }
      }),
    );
    return lo.length;
  }

  private async xuLy(tenantId: string, id: string): Promise<void> {
    // ---- pha 1: đọc --------------------------------------------------------
    const doc = await this.tdb.runAs(tenantId, async (tx) => {
      const o = await tx
        .selectFrom('notification_outbox as o')
        .leftJoin('member as m', 'm.id', 'o.member_id')
        .leftJoin('identity as i', 'i.id', 'm.identity_id')
        .select([
          'o.id', 'o.channel', 'o.template_code', 'o.recipient_ref', 'o.payload', 'o.status',
          'o.member_id', 'o.idempotency_key',
          'o.attempts', 'o.created_at', 'i.full_name as member_name', 'i.phone as member_phone',
        ])
        .where('o.id', '=', id)
        .executeTakeFirst();
      if (!o || o.status !== 'SENDING') return null;

      const tenant = await tx.selectFrom('tenant').select('name').executeTakeFirst();
      const mau = await tx
        .selectFrom('tenant_zns_template')
        .select(['provider_tpl_id', 'status'])
        .where('template_code', '=', o.template_code)
        .executeTakeFirst();
      // Hạn mức gói: đọc CÙNG lúc với dòng tin, ngay trước khi gửi.
      const hanMuc = o.channel === 'ZALO_ZNS' ? await hanMucTinThang(tx) : null;
      return { o, gymName: tenant?.name ?? '', mau, hanMuc };
    });
    if (!doc) return;
    const { o, gymName, mau, hanMuc } = doc;
    const payload = (o.payload ?? {}) as Record<string, unknown>;

    // ---- pha 2: quyết định + gửi (ngoài transaction) -----------------------
    let ketThuc = await this.giao(tenantId, {
      id: o.id,
      channel: o.channel,
      templateCode: o.template_code,
      phone: o.member_phone ?? (o.recipient_ref.startsWith('+') ? o.recipient_ref : null),
      memberName: o.member_name ?? '',
      gymName,
      payload,
      createdAt: new Date(o.created_at),
      mau,
      hanMuc,
    });

    // OTP không qua được Zalo (hội viên không dùng Zalo, mẫu chưa duyệt, token
    // chết, Zalo lỗi...): chuyển NGAY sang SMS thay vì chờ lượt thử lại — mã
    // chỉ sống 5 phút, lượt thử thứ hai đã là 30 giây sau, lượt ba 2 phút.
    let duPhong: DuPhong | undefined;
    if (
      o.channel === 'ZALO_ZNS' &&
      o.template_code === 'OTP_LOGIN' &&
      ketThuc.status !== 'SENT' &&
      !ketThuc.error.startsWith('EXPIRED') &&
      this.sms.enabled
    ) {
      duPhong = { recipientRef: o.recipient_ref, memberId: o.member_id, idempotencyKey: `${o.idempotency_key}:SMS`, payload };
      ketThuc = {
        status: ketThuc.status === 'SKIPPED' ? 'SKIPPED' : 'FAILED',
        error: `${ketThuc.error} — đã chuyển sang SMS`,
      };
    }

    // ---- pha 3: ghi kết quả -----------------------------------------------
    await this.ghi(tenantId, o.id, o.attempts, ketThuc, payload, duPhong);
  }

  private async giao(
    tenantId: string,
    t: {
      id: string;
      channel: string;
      templateCode: string;
      phone: string | null;
      memberName: string;
      gymName: string;
      payload: Record<string, unknown>;
      createdAt: Date;
      mau: { provider_tpl_id: string | null; status: string } | undefined;
      hanMuc: { used: number; limit: number | null } | null;
    },
  ): Promise<KetThuc> {
    // Hạn riêng của tin (mã OTP sống 5 phút) đứng trước hạn chung.
    const han = typeof t.payload.expiresAt === 'string' ? new Date(t.payload.expiresAt).getTime() : NaN;
    if ((Number.isFinite(han) && han < Date.now()) || Date.now() - t.createdAt.getTime() > TUOI_TOI_DA_MS) {
      return { status: 'SKIPPED', error: 'EXPIRED: tin đã quá hạn, gửi bây giờ là thông tin sai' };
    }

    switch (t.channel) {
      case 'INAPP':
        // Tin trong ứng dụng: nằm sẵn trong CSDL, không có gì để "gửi".
        return { status: 'SENT', providerMsgId: null, channel: t.channel };
      case 'ZALO_ZNS':
        break;
      case 'SMS':
        return this.giaoSms(tenantId, t);
      default:
        return { status: 'SKIPPED', error: `CHANNEL_NOT_CONFIGURED: kênh ${t.channel} chưa được cấu hình` };
    }

    if (!laMaMau(t.templateCode)) return { status: 'FAILED', error: `UNKNOWN_TEMPLATE: ${t.templateCode}` };
    if (!t.phone) return { status: 'SKIPPED', error: 'NO_PHONE: hội viên không có số điện thoại' };
    if (t.hanMuc && hetHanMuc(t.hanMuc) && !MIEN_HAN_MUC.has(t.templateCode)) {
      return {
        status: 'SKIPPED',
        error: `QUOTA_EXCEEDED: đã gửi ${t.hanMuc.used}/${t.hanMuc.limit} tin Zalo của gói trong tháng này`,
      };
    }
    if (t.mau?.status !== 'APPROVED' || !t.mau.provider_tpl_id) {
      return { status: 'SKIPPED', error: `TEMPLATE_NOT_APPROVED: mẫu ${t.templateCode} chưa khai mã Zalo đã duyệt` };
    }

    const bm = this.moBiMat(tenantId, t.payload);
    if (!bm.ok) return { status: 'FAILED', error: 'SECRET_UNREADABLE: không giải mã được nội dung tin' };
    const secret = bm.secret;

    const data = MAU_TIN[t.templateCode].build({ memberName: t.memberName, gymName: t.gymName, payload: t.payload, secret });

    let tk = await this.oa.accessTokenFor(tenantId);
    if (!tk.ok) return tk.retry ? { status: 'RETRY', error: tk.reason } : { status: 'SKIPPED', error: tk.reason };

    const gui = (token: string) =>
      this.zalo.sendTemplate({
        accessToken: token,
        phone: t.phone!,
        templateId: t.mau!.provider_tpl_id!,
        data,
        trackingId: t.id,
      });

    let kq = await gui(tk.token);
    if (!kq.ok && kq.kind === 'token') {
      // Token bị từ chối trước hạn (thu hồi, đổi quyền): làm mới một lần rồi thử lại ngay.
      tk = await this.oa.accessTokenFor(tenantId, tk.token);
      if (!tk.ok) return tk.retry ? { status: 'RETRY', error: tk.reason } : { status: 'SKIPPED', error: tk.reason };
      kq = await gui(tk.token);
    }

    if (kq.ok) return { status: 'SENT', providerMsgId: kq.msgId, channel: t.channel };
    if (kq.kind === 'permanent') return { status: 'FAILED', error: kq.error };
    return { status: 'RETRY', error: kq.error };
  }

  /** Mã OTP niêm phong theo phòng trong payload (nếu có). */
  private moBiMat(tenantId: string, payload: Record<string, unknown>): { ok: true; secret?: string } | { ok: false } {
    if (typeof payload.codeEnc !== 'string') return { ok: true };
    try {
      return {
        ok: true,
        secret: moNiemPhong(this.cfg.getOrThrow('TENANT_SECRET_KEY'), tenantId, 'otp.code', Buffer.from(payload.codeEnc, 'base64')),
      };
    } catch {
      return { ok: false };
    }
  }

  private async giaoSms(
    tenantId: string,
    t: { id: string; templateCode: string; phone: string | null; gymName: string; payload: Record<string, unknown> },
  ): Promise<KetThuc> {
    if (!this.sms.enabled) return { status: 'SKIPPED', error: 'SMS_NOT_CONFIGURED: chưa cấu hình nhà cung cấp SMS' };
    if (!t.phone) return { status: 'SKIPPED', error: 'NO_PHONE: không có số điện thoại' };
    const bm = this.moBiMat(tenantId, t.payload);
    if (!bm.ok) return { status: 'FAILED', error: 'SECRET_UNREADABLE: không giải mã được nội dung tin' };
    const text = noiDungSms(t.templateCode, { gymName: t.gymName, secret: bm.secret });
    if (!text) return { status: 'SKIPPED', error: `SMS_TEMPLATE_UNSUPPORTED: mẫu ${t.templateCode} không gửi qua SMS` };

    const kq = await this.sms.send({ phone: t.phone, text, trackingId: t.id });
    if (kq.ok) return { status: 'SENT', providerMsgId: kq.msgId, channel: 'SMS' };
    return kq.kind === 'permanent' ? { status: 'FAILED', error: kq.error } : { status: 'RETRY', error: kq.error };
  }

  private async ghi(
    tenantId: string,
    id: string,
    attemptsLucDoc: number,
    k: KetThuc,
    payload: Record<string, unknown>,
    duPhong?: DuPhong,
  ): Promise<void> {
    // Mã OTP đã niêm phong vẫn là mã OTP: xoá khỏi CSDL ngay khi tin kết thúc
    // (gửi được hay không). Thử lại thì còn cần, nên chỉ xoá ở trạng thái cuối.
    const hetLuot = attemptsLucDoc >= SO_LAN_TOI_DA;
    const cuoi = k.status !== 'RETRY' || hetLuot;
    let payloadSach: Record<string, unknown> | null = null;
    if (cuoi && 'codeEnc' in payload) {
      const { codeEnc: _bo, ...conLai } = payload;
      payloadSach = conLai;
    }

    await this.tdb.runAs(tenantId, async (tx) => {
      const q = tx
        .updateTable('notification_outbox')
        .where('id', '=', id)
        .where('status', '=', 'SENDING')
        .where('attempts', '=', attemptsLucDoc);

      let r;
      if (k.status === 'SENT') {
        r = await q
          .set({
            status: 'SENT',
            sent_at: new Date(),
            provider_msg_id: k.providerMsgId,
            last_error: null,
            ...(payloadSach ? { payload: JSON.stringify(payloadSach) } : {}),
          })
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) > 0) {
          await tx
            .insertInto('tenant_message_usage')
            .values({
              tenant_id: tenantId,
              period_month: sql`date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
              channel: k.channel,
              sent_count: 1,
            })
            .onConflict((oc) =>
              oc.columns(['tenant_id', 'period_month', 'channel']).doUpdateSet({
                sent_count: sql`tenant_message_usage.sent_count + 1`,
              }),
            )
            .execute();
        }
      } else if (k.status === 'RETRY' && !hetLuot) {
        r = await q
          .set({ status: 'PENDING', last_error: k.error, next_attempt_at: new Date(Date.now() + lui(attemptsLucDoc)) })
          .executeTakeFirst();
      } else {
        r = await q
          .set({
            status: k.status === 'RETRY' ? 'FAILED' : k.status,
            last_error: k.status === 'RETRY' ? `Hết ${SO_LAN_TOI_DA} lần thử: ${k.error}` : k.error,
            ...(payloadSach ? { payload: JSON.stringify(payloadSach) } : {}),
          })
          .executeTakeFirst();
      }

      if (Number(r?.numUpdatedRows ?? 0) === 0) {
        this.log.warn(`Tin #${id}: lease đã bị worker khác lấy lại — bỏ kết quả của lần này`);
      } else if (duPhong) {
        // Cùng transaction với kết quả tin Zalo: payload GỐC (còn mã niêm
        // phong) đi sang dòng SMS; dòng Zalo vừa được xoá mã ở trên.
        await tx
          .insertInto('notification_outbox')
          .values({
            tenant_id: tenantId,
            channel: 'SMS',
            template_code: 'OTP_LOGIN',
            recipient_ref: duPhong.recipientRef,
            member_id: duPhong.memberId,
            idempotency_key: duPhong.idempotencyKey,
            payload: JSON.stringify(duPhong.payload),
          })
          .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing())
          .execute();
      }
    });

    if (k.status !== 'SENT') this.log.debug(`Tin #${id} -> ${k.status}: ${'error' in k ? k.error : ''}`);
  }
}
