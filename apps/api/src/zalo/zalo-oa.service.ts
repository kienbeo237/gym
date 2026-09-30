import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type {
  SaveZaloCredentialsRequest,
  SaveZaloWebhookSecretRequest,
  TemplateCode,
  UpdateZnsTemplateRequest,
  ZaloCallbackRequest,
  ZaloOaInfo,
  ZnsTemplateRow,
} from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { moNiemPhong, niemPhong, type MucDich } from '../common/secret-box';
import { EphemeralStore } from '../redis/ephemeral-store.service';
import { RateLimitService } from '../redis/rate-limit.service';
import { tenantKey } from '../redis/redis-keys';
import { MAU_TIN } from '../notification/templates';
import { ZaloApi, type TokenPair } from './zalo-api';

/** Làm mới khi token còn dưới chừng này — tránh gửi bằng token sắp chết. */
const BIEN_AN_TOAN_MS = 5 * 60_000;
/** Job định kỳ làm mới sớm khi token còn dưới chừng này. */
const LAM_MOI_SOM_MS = 2 * 3600_000;
const HAN_PKCE_GIAY = 600;

export type KetQuaAccessToken =
  | { ok: true; token: string }
  /** retry=false: phải có người kết nối lại OA, thử lại tự động vô ích. */
  | { ok: false; retry: boolean; reason: string };

const b64url = (b: Buffer) => b.toString('base64url');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Kết nối Zalo OA của TỪNG phòng tập.
 *
 * Mỗi phòng một OA, một bộ credential, một cặp token. Mọi thứ nhạy cảm nằm
 * trong CSDL ở dạng niêm phong theo phòng (common/secret-box.ts) và KHÔNG BAO
 * GIỜ đi ra API — kể cả ở dạng che bớt.
 */
@Injectable()
export class ZaloOaService {
  private readonly log = new Logger(ZaloOaService.name);

  constructor(
    private readonly tdb: TenantDb,
    private readonly zalo: ZaloApi,
    private readonly kv: EphemeralStore,
    private readonly rate: RateLimitService,
    private readonly cfg: ConfigService,
  ) {}

  private get masterKey(): string {
    return this.cfg.getOrThrow<string>('TENANT_SECRET_KEY');
  }

  private seal(tenantId: string, muc: MucDich, v: string): Buffer {
    return niemPhong(this.masterKey, tenantId, muc, v);
  }

  private open(tenantId: string, muc: MucDich, v: Buffer): string {
    return moNiemPhong(this.masterKey, tenantId, muc, v);
  }

  private get webOrigin(): string {
    return (this.cfg.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000').split(',')[0]!.trim().replace(/\/$/, '');
  }

  get redirectUri(): string {
    return `${this.webOrigin}/settings/zalo/callback`;
  }

  /** nginx chuyển /api/* (trừ /api/proxy, /api/session) thẳng tới API. */
  webhookUrl(tenantId: string): string {
    return `${this.webOrigin}/api/webhooks/zalo/${tenantId}`;
  }

  // ---------------------------------------------------------------------------
  // Màn cài đặt (chạy trong request, tenant lấy từ token)
  // ---------------------------------------------------------------------------

  async info(): Promise<ZaloOaInfo> {
    const { tenantId } = requireContext();
    const r = await this.tdb.run((tx) =>
      tx
        .selectFrom('tenant_zalo_oa')
        .select((eb) => [
          'status', 'app_id', 'oa_id', 'connected_at', 'token_expires_at', 'last_error',
          eb('webhook_secret_enc', 'is not', null).as('has_webhook_secret'),
        ])
        .executeTakeFirst(),
    );
    return {
      status: (r?.status as ZaloOaInfo['status']) ?? 'DISCONNECTED',
      appId: r?.app_id ?? null,
      oaId: r?.oa_id ?? null,
      hasSecret: !!r,
      connectedAt: r?.connected_at ? new Date(r.connected_at).toISOString() : null,
      tokenExpiresAt: r?.token_expires_at ? new Date(r.token_expires_at).toISOString() : null,
      lastError: r?.last_error ?? null,
      redirectUri: this.redirectUri,
      driver: this.zalo.driver,
      hasWebhookSecret: !!r?.has_webhook_secret,
      webhookUrl: this.webhookUrl(tenantId),
    };
  }

  /**
   * Lưu / gỡ "OA Secret Key" của mục Webhook. Chưa khai = webhook báo phát của
   * phòng này trả 404 — không nhận sự kiện nào không kiểm được chữ ký.
   */
  async saveWebhookSecret(dto: SaveZaloWebhookSecretRequest): Promise<ZaloOaInfo> {
    const { tenantId } = requireContext();
    const r = await this.tdb.run((tx) =>
      tx
        .updateTable('tenant_zalo_oa')
        .set({ webhook_secret_enc: dto.secretKey ? this.seal(tenantId, 'zalo.webhook', dto.secretKey) : null })
        .executeTakeFirst(),
    );
    if (Number(r.numUpdatedRows) === 0) {
      throw new BadRequestException({ code: 'ZALO_NOT_CONFIGURED', message: 'Lưu App ID và Secret Key trước' });
    }
    return this.info();
  }

  /**
   * Lưu App ID + Secret Key. Đổi sang ỨNG DỤNG KHÁC thì token cũ vô nghĩa, nên
   * xoá luôn và quay về DISCONNECTED — giữ lại là gửi tin bằng token của một
   * ứng dụng mà secret hiện tại không làm mới được.
   */
  async saveCredentials(dto: SaveZaloCredentialsRequest): Promise<ZaloOaInfo> {
    const { tenantId } = requireContext();
    const secretEnc = this.seal(tenantId, 'zalo.secret', dto.secretKey);

    await this.tdb.run(async (tx) => {
      const cu = await tx.selectFrom('tenant_zalo_oa').select(['app_id']).forUpdate().executeTakeFirst();
      if (!cu) {
        await tx
          .insertInto('tenant_zalo_oa')
          .values({ tenant_id: tenantId, app_id: dto.appId, secret_enc: secretEnc, status: 'DISCONNECTED' })
          .execute();
        return;
      }
      const doiApp = cu.app_id !== dto.appId;
      await tx
        .updateTable('tenant_zalo_oa')
        .set({
          app_id: dto.appId,
          secret_enc: secretEnc,
          last_error: null,
          ...(doiApp
            ? {
                status: 'DISCONNECTED',
                oa_id: null,
                access_token_enc: null,
                refresh_token_enc: null,
                token_expires_at: null,
                connected_at: null,
                // Khoá webhook thuộc về ứng dụng cũ.
                webhook_secret_enc: null,
              }
            : {}),
        })
        .execute();
    });
    return this.info();
  }

  /**
   * Bước 1 của OAuth v4 + PKCE: sinh `state` và `code_verifier`, cất verifier
   * vào Redis dưới khoá CỦA PHÒNG NÀY.
   *
   * Khoá theo tenant là thứ buộc `state` vào đúng phòng: một người đăng nhập
   * phòng B mang `state` của phòng A tới callback sẽ không tìm thấy verifier,
   * nên không thể gắn OA của mình vào phòng khác (hay ngược lại).
   */
  async startConnect(): Promise<{ url: string }> {
    const { tenantId } = requireContext();
    const row = await this.tdb.run((tx) =>
      tx.selectFrom('tenant_zalo_oa').select(['app_id']).executeTakeFirst(),
    );
    if (!row) {
      throw new BadRequestException({
        code: 'ZALO_NO_CREDENTIALS',
        message: 'Nhập App ID và Secret Key của ứng dụng Zalo trước khi kết nối',
      });
    }

    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());

    try {
      await this.kv.put(tenantKey(tenantId, 'zalo', 'pkce', state), verifier, HAN_PKCE_GIAY);
    } catch {
      throw new ServiceUnavailableException({
        code: 'ZALO_STATE_STORE_DOWN',
        message: 'Không lưu được phiên kết nối (Redis). Thử lại sau ít phút.',
      });
    }

    return {
      url: this.zalo.authorizeUrl({ appId: row.app_id, redirectUri: this.redirectUri, codeChallenge: challenge, state }),
    };
  }

  /** Bước 2: Zalo chuyển hướng về kèm `code` — đổi lấy cặp token rồi niêm phong. */
  async completeConnect(dto: ZaloCallbackRequest): Promise<ZaloOaInfo> {
    const { tenantId } = requireContext();

    let verifier: string | null;
    try {
      verifier = await this.kv.take(tenantKey(tenantId, 'zalo', 'pkce', dto.state));
    } catch {
      throw new ServiceUnavailableException({ code: 'ZALO_STATE_STORE_DOWN', message: 'Redis không phản hồi' });
    }
    if (!verifier) {
      throw new BadRequestException({
        code: 'ZALO_STATE_INVALID',
        message: 'Phiên kết nối đã hết hạn hoặc không thuộc phòng tập này. Bấm "Kết nối" lại.',
      });
    }

    const row = await this.tdb.run((tx) =>
      tx.selectFrom('tenant_zalo_oa').select(['app_id', 'secret_enc']).executeTakeFirst(),
    );
    if (!row) throw new BadRequestException({ code: 'ZALO_NO_CREDENTIALS', message: 'Chưa có App ID / Secret Key' });

    // Gọi Zalo NGOÀI transaction.
    const kq = await this.zalo.exchangeCode({
      appId: row.app_id,
      secretKey: this.open(tenantId, 'zalo.secret', row.secret_enc),
      code: dto.code,
      codeVerifier: verifier,
    });

    if (!kq.ok) {
      await this.tdb.run((tx) =>
        tx.updateTable('tenant_zalo_oa').set({ status: 'ERROR', last_error: kq.error }).execute(),
      );
      throw new BadRequestException({ code: 'ZALO_EXCHANGE_FAILED', message: kq.error });
    }

    await this.tdb.run((tx) =>
      tx
        .updateTable('tenant_zalo_oa')
        .set({
          ...this.cotToken(tenantId, kq.tokens),
          oa_id: dto.oaId,
          status: 'CONNECTED',
          connected_at: new Date(),
          last_error: null,
        })
        .execute(),
    );
    this.log.log(`Phòng ${tenantId} đã kết nối OA ${dto.oaId}`);
    return this.info();
  }

  /** Ngắt kết nối: xoá token, GIỮ credential để kết nối lại chỉ cần một cú bấm. */
  async disconnect(): Promise<ZaloOaInfo> {
    await this.tdb.run((tx) =>
      tx
        .updateTable('tenant_zalo_oa')
        .set({
          status: 'DISCONNECTED',
          access_token_enc: null,
          refresh_token_enc: null,
          token_expires_at: null,
          connected_at: null,
          last_error: null,
        })
        .execute(),
    );
    return this.info();
  }

  async listTemplates(): Promise<ZnsTemplateRow[]> {
    const rows = await this.tdb.run((tx) =>
      tx.selectFrom('tenant_zns_template').select(['template_code', 'provider_tpl_id', 'status']).execute(),
    );
    const theoMa = new Map(rows.map((r) => [r.template_code, r]));
    return (Object.keys(MAU_TIN) as TemplateCode[]).map((code) => {
      const m = MAU_TIN[code];
      const r = theoMa.get(code);
      return {
        code,
        name: m.name,
        description: m.description,
        params: m.params,
        providerTplId: r?.provider_tpl_id ?? null,
        status: (r?.status as ZnsTemplateRow['status']) ?? 'NOT_SET',
      };
    });
  }

  async updateTemplate(code: TemplateCode, dto: UpdateZnsTemplateRequest): Promise<ZnsTemplateRow[]> {
    const { tenantId } = requireContext();
    await this.tdb.run((tx) =>
      tx
        .insertInto('tenant_zns_template')
        .values({
          tenant_id: tenantId,
          template_code: code,
          provider_tpl_id: dto.providerTplId || null,
          status: dto.status,
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'template_code']).doUpdateSet({
            provider_tpl_id: dto.providerTplId || null,
            status: dto.status,
            reject_reason: null,
          }),
        )
        .execute(),
    );
    return this.listTemplates();
  }

  // ---------------------------------------------------------------------------
  // Worker (không có request — tenant truyền tường minh)
  // ---------------------------------------------------------------------------

  private cotToken(tenantId: string, t: TokenPair) {
    return {
      access_token_enc: this.seal(tenantId, 'zalo.access', t.accessToken),
      refresh_token_enc: this.seal(tenantId, 'zalo.refresh', t.refreshToken),
      token_expires_at: new Date(Date.now() + t.expiresInSeconds * 1000),
    };
  }

  private docOa(tenantId: string) {
    return this.tdb.runAs(tenantId, (tx) =>
      tx
        .selectFrom('tenant_zalo_oa')
        .select(['status', 'app_id', 'secret_enc', 'access_token_enc', 'refresh_token_enc', 'token_expires_at'])
        .executeTakeFirst(),
    );
  }

  /**
   * Access token còn dùng được của phòng `tenantId`, làm mới nếu cần.
   *
   * `failedToken`: token mà Zalo vừa từ chối. Nếu CSDL đang giữ token KHÁC nghĩa
   * là worker khác đã làm mới xong — dùng luôn, không làm mới lần nữa (mỗi lần
   * làm mới thừa là đốt một refresh token dùng-một-lần).
   */
  async accessTokenFor(tenantId: string, failedToken?: string): Promise<KetQuaAccessToken> {
    const r = await this.docOa(tenantId);
    if (!r || r.status === 'DISCONNECTED') return { ok: false, retry: false, reason: 'OA_NOT_CONNECTED' };
    if (r.status === 'TOKEN_EXPIRED') return { ok: false, retry: false, reason: 'OA_TOKEN_EXPIRED' };
    if (!r.access_token_enc || !r.token_expires_at) return { ok: false, retry: false, reason: 'OA_NOT_CONNECTED' };

    const token = this.open(tenantId, 'zalo.access', r.access_token_enc);
    const conHan = new Date(r.token_expires_at).getTime() - Date.now() > BIEN_AN_TOAN_MS;
    if (failedToken ? token !== failedToken : conHan) return { ok: true, token };

    return this.lamMoi(tenantId, failedToken);
  }

  /** Job định kỳ: làm mới SỚM để không tin nào phải chờ làm mới giữa đường. */
  async refreshIfExpiringSoon(tenantId: string): Promise<boolean> {
    const r = await this.docOa(tenantId);
    if (r?.status !== 'CONNECTED' || !r.token_expires_at) return false;
    if (new Date(r.token_expires_at).getTime() - Date.now() > LAM_MOI_SOM_MS) return false;
    const kq = await this.lamMoi(tenantId);
    return kq.ok;
  }

  /**
   * Làm mới token dưới KHOÁ PHÂN TÁN.
   *
   * Refresh token của Zalo dùng một lần. Hai worker cùng làm mới thì cái thứ
   * hai nhận "token không hợp lệ", phòng đó bị đánh dấu hết hạn và TOÀN BỘ tin
   * của họ ngừng gửi — không lỗi rõ ràng nào, chỉ là khách không nhận tin nữa.
   *
   * Redis chết thì KHÔNG làm mới (fail-closed) — ngược với giới hạn tần suất.
   * Ở đây làm mới trùng tệ hơn nhiều so với chậm vài phút.
   */
  private async lamMoi(tenantId: string, failedToken?: string): Promise<KetQuaAccessToken> {
    let nha: (() => Promise<void>) | null;
    try {
      nha = await this.rate.acquire(tenantKey(tenantId, 'zalo', 'refresh'), 60);
    } catch {
      return { ok: false, retry: true, reason: 'REDIS_UNAVAILABLE' };
    }

    if (!nha) {
      // Người khác đang làm mới. Chờ một nhịp rồi đọc lại kết quả của họ.
      await sleep(1500);
      const r = await this.docOa(tenantId);
      if (r?.status === 'CONNECTED' && r.access_token_enc) {
        const t = this.open(tenantId, 'zalo.access', r.access_token_enc);
        if (t !== failedToken) return { ok: true, token: t };
      }
      return { ok: false, retry: true, reason: 'REFRESH_IN_PROGRESS' };
    }

    try {
      // Đọc LẠI trong khoá: có thể ai đó vừa làm mới xong ngay trước khi ta giành được.
      const r = await this.docOa(tenantId);
      if (r?.status !== 'CONNECTED' || !r.refresh_token_enc || !r.access_token_enc || !r.token_expires_at) {
        return { ok: false, retry: false, reason: 'OA_NOT_CONNECTED' };
      }
      const hienTai = this.open(tenantId, 'zalo.access', r.access_token_enc);
      const conHan = new Date(r.token_expires_at).getTime() - Date.now() > BIEN_AN_TOAN_MS;
      if (failedToken ? hienTai !== failedToken : conHan && !this.canLamMoiSom(r.token_expires_at)) {
        return { ok: true, token: hienTai };
      }

      const kq = await this.zalo.refresh({
        appId: r.app_id,
        secretKey: this.open(tenantId, 'zalo.secret', r.secret_enc),
        refreshToken: this.open(tenantId, 'zalo.refresh', r.refresh_token_enc),
      });

      if (!kq.ok) {
        await this.tdb.runAs(tenantId, (tx) =>
          tx
            .updateTable('tenant_zalo_oa')
            .set(kq.kind === 'invalid' ? { status: 'TOKEN_EXPIRED', last_error: kq.error } : { last_error: kq.error })
            .execute(),
        );
        this.log.warn(`Làm mới token OA của phòng ${tenantId} thất bại: ${kq.error}`);
        return { ok: false, retry: kq.kind === 'transient', reason: kq.kind === 'invalid' ? 'OA_TOKEN_EXPIRED' : 'ZALO_UNREACHABLE' };
      }

      try {
        await this.tdb.runAs(tenantId, (tx) =>
          tx
            .updateTable('tenant_zalo_oa')
            .set({ ...this.cotToken(tenantId, kq.tokens), status: 'CONNECTED', last_error: null })
            .execute(),
        );
      } catch (e) {
        // Zalo đã cấp cặp mới và token cũ đã chết — không lưu được là MẤT kết
        // nối cho tới khi chủ phòng kết nối lại. Báo to, đừng nuốt.
        this.log.error(
          `ĐÃ làm mới token OA phòng ${tenantId} nhưng KHÔNG lưu được — phòng này cần kết nối lại Zalo: ${String(e)}`,
        );
        throw e;
      }
      return { ok: true, token: kq.tokens.accessToken };
    } finally {
      await nha();
    }
  }

  /** Job làm mới sớm gọi lamMoi() khi token còn < 2 giờ — đừng coi đó là "còn hạn". */
  private canLamMoiSom(expiresAt: Date | string): boolean {
    return new Date(expiresAt).getTime() - Date.now() <= LAM_MOI_SOM_MS;
  }
}
