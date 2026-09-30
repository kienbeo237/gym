import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Kysely } from 'kysely';
import type {
  DB,
  LoginRequest,
  LoginResponse,
  PlatformLevel,
  PlatformSessionResponse,
  PlatformTokenClaims,
  SessionResponse,
  TenantOption,
  TenantRole,
  PreTokenClaims,
  AccessTokenClaims,
} from '@pt/contracts';
import { DB_AUTH } from '../db/database.module';
import { RateLimitService } from '../redis/rate-limit.service';
import { globalKey, phoneKeyPart } from '../redis/redis-keys';
import { devLoginBat } from '../common/config-guard';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/**
 * Dùng lại refresh token VỪA xoay (trong vòng này) không bị coi là bị đánh cắp.
 *
 * Trình duyệt mở một trang là vài request song song (trang + prefetch + gọi
 * API từ client). Access token hết hạn thì CẢ vài request cùng cầm một refresh
 * token đi làm mới: request đầu xoay, các request sau thấy token "đã thu hồi".
 * Coi đó là trộm thì người dùng bị đăng xuất khỏi mọi thiết bị mỗi 15 phút.
 *
 * Đổi lại: kẻ trộm dùng token trong đúng 30 giây sau lượt xoay hợp lệ thì cũng
 * lọt. Sau 30 giây, dùng lại vẫn thu hồi cả họ token như cũ.
 */
const REUSE_GRACE_MS = 30_000;

/**
 * Xác thực chạy TRƯỚC khi có ngữ cảnh tenant, nên nó là nơi DUY NHẤT dùng
 * kết nối app_auth (BYPASSRLS, quyền hẹp). Mọi thứ khác đi qua TenantDb.
 *
 * Hai bước có chủ đích: một số điện thoại có thể là hội viên ở phòng A và PT ở
 * phòng B. Hỏi "vào phòng nào" rồi mới ký token mang tenantId.
 */
@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    @Inject(DB_AUTH) private readonly db: Kysely<DB>,
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
    private readonly rate: RateLimitService,
  ) {}

  private hashToken(raw: string): string {
    // sha256 chứ không phải bcrypt: đây là token ngẫu nhiên 256 bit, không phải
    // mật khẩu người đặt, nên không cần làm chậm — và refresh chạy rất thường.
    return sha256(raw);
  }

  async login(req: LoginRequest): Promise<LoginResponse> {
    // Chặn dò mật khẩu. Khoá băm số điện thoại vì nó là dữ liệu cá nhân và
    // Redis không phải nơi để nó nằm ở dạng đọc được.
    const k = globalKey('login', 'pw', phoneKeyPart(req.phone, (s) => sha256(s)));
    const verdict = await this.rate.hit(k, 10, 900);
    if (!verdict.allowed) {
      throw new BadRequestException({
        code: 'LOGIN_RATE_LIMITED',
        message: 'Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau.',
        retryAfterSeconds: verdict.retryAfterSeconds,
      });
    }

    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'full_name', 'password_hash', 'status', 'must_change_password'])
      .where('phone', '=', req.phone)
      .executeTakeFirst();

    // So sánh mật khẩu KỂ CẢ khi không tìm thấy tài khoản: thời gian phản hồi
    // khác nhau là kênh dò xem số nào đã đăng ký.
    const hash = identity?.password_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
    const ok = await bcrypt.compare(req.password, hash);
    if (!identity || !ok) throw new UnauthorizedException('INVALID_CREDENTIALS');
    if (identity.status !== 'ACTIVE') throw new ForbiddenException('ACCOUNT_LOCKED');

    await this.rate.reset(k);
    await this.db
      .updateTable('identity')
      .set({ last_login_at: new Date() })
      .where('id', '=', identity.id)
      .execute();

    if (identity.must_change_password) {
      // Mật khẩu tạm: chưa cho chọn phòng, chưa cho vào nền tảng. preToken ở
      // đây chỉ mở được đúng một cửa — đổi mật khẩu.
      const preToken = await this.jwt.signAsync(
        { sub: identity.id, stage: 'CHANGE_PASSWORD', amr: 'pwd' } satisfies Omit<PreTokenClaims, 'iat' | 'exp'>,
        { secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '10m' },
      );
      return {
        preToken,
        identityId: identity.id,
        fullName: identity.full_name,
        tenants: [],
        platform: null,
        mustChangePassword: true,
      };
    }

    return this.completeAuthentication(identity.id, 'pwd');
  }

  /**
   * Đăng nhập nhanh CHỈ bằng số điện thoại — máy lập trình / staging, để thử vai HLV /
   * hội viên mà không cần mật khẩu hay kênh gửi OTP. Cờ tắt thì trả 404 như
   * route không tồn tại. Bỏ qua cả mật khẩu tạm: đây là để thử màn hình, không
   * phải để thử luồng đổi mật khẩu (luồng đó vẫn thử được qua tab Mật khẩu).
   */
  async devLogin(phone: string): Promise<LoginResponse> {
    if (!devLoginBat()) throw new NotFoundException();

    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'status'])
      .where('phone', '=', phone)
      .executeTakeFirst();
    // Ở dev nói thẳng số không tồn tại: không có danh sách khách hàng thật nào để dò.
    if (!identity) throw new BadRequestException({ code: 'DEV_LOGIN_UNKNOWN_PHONE', message: 'Không có tài khoản nào với số này' });
    if (identity.status !== 'ACTIVE') throw new ForbiddenException('ACCOUNT_LOCKED');

    this.log.warn(`DEV_LOGIN_BYPASS: đăng nhập không xác thực vào ${identity.id}`);
    return this.completeAuthentication(identity.id, 'dev');
  }

  /**
   * Đặt mật khẩu mới thay mật khẩu tạm, rồi đi tiếp bước 1 như đăng nhập thường.
   *
   * Thu hồi MỌI refresh token của người này: ai đã đăng nhập bằng mật khẩu tạm
   * trước đó (người vận hành thử hộ chẳng hạn) đều bị đẩy ra.
   */
  async changePassword(preToken: string, newPassword: string): Promise<LoginResponse> {
    const claims = await this.verifyPreToken(preToken, 'CHANGE_PASSWORD');
    const cur = await this.db
      .selectFrom('identity')
      .select(['password_hash', 'status'])
      .where('id', '=', claims.sub)
      .executeTakeFirst();
    if (!cur || cur.status !== 'ACTIVE') throw new ForbiddenException('ACCOUNT_LOCKED');
    if (cur.password_hash && (await bcrypt.compare(newPassword, cur.password_hash))) {
      throw new BadRequestException({ code: 'SAME_PASSWORD', message: 'Mật khẩu mới phải khác mật khẩu tạm.' });
    }

    await this.db
      .updateTable('identity')
      .set({ password_hash: await bcrypt.hash(newPassword, 10), must_change_password: false, updated_at: new Date() })
      .where('id', '=', claims.sub)
      .execute();
    await this.db
      .updateTable('refresh_token')
      .set({ revoked_at: new Date(), revoked_reason: 'PASSWORD_CHANGED' })
      .where('identity_id', '=', claims.sub)
      .where('revoked_at', 'is', null)
      .execute();

    return this.completeAuthentication(claims.sub, 'pwd');
  }

  /**
   * Kết thúc bước 1 sau khi đã xác thực được NGƯỜI, bằng bất kỳ cách nào —
   * mật khẩu hoặc OTP. Tách ra để hai đường đăng nhập cho ra đúng cùng một kết
   * quả: cùng preToken, cùng danh sách phòng, cùng thời hạn.
   *
   * Hai đường tự dựng preToken riêng là hai chỗ để lệch nhau về sau (thời hạn,
   * claim thiếu), và lệch ở đây là lệch về bảo mật.
   */
  async completeAuthentication(identityId: string, amr: PreTokenClaims['amr']): Promise<LoginResponse> {
    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'full_name'])
      .where('id', '=', identityId)
      .executeTakeFirstOrThrow();

    const tenants = await this.tenantsOf(identity.id);
    // Cửa nền tảng chỉ hiện với đăng nhập bằng mật khẩu — xem LoginResponse.platform.
    const level = amr !== 'otp' ? await this.platformLevelOf(identity.id) : null;
    if (tenants.length === 0 && !level) throw new ForbiddenException('NO_TENANT_MEMBERSHIP');

    const preToken = await this.jwt.signAsync(
      { sub: identity.id, stage: 'SELECT_TENANT', amr } satisfies Omit<PreTokenClaims, 'iat' | 'exp'>,
      { secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '5m' },
    );

    return {
      preToken,
      identityId: identity.id,
      fullName: identity.full_name,
      tenants,
      platform: level ? { level } : null,
      mustChangePassword: false,
    };
  }

  private async verifyPreToken(
    preToken: string,
    stage: PreTokenClaims['stage'] = 'SELECT_TENANT',
  ): Promise<PreTokenClaims> {
    let claims: PreTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<PreTokenClaims>(preToken, {
        secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('INVALID_PRE_TOKEN');
    }
    if (claims.stage !== stage) throw new UnauthorizedException('INVALID_PRE_TOKEN');
    return claims;
  }

  async selectTenant(preToken: string, tenantId: string, ua?: string): Promise<SessionResponse> {
    const claims = await this.verifyPreToken(preToken);
    const tenants = await this.tenantsOf(claims.sub);
    const chosen = tenants.find((t) => t.tenantId === tenantId);
    if (!chosen) throw new ForbiddenException('NOT_A_MEMBER_OF_TENANT');

    return this.issueSession(claims.sub, chosen, randomUUID(), ua);
  }

  /**
   * Bước 2, nhánh nền tảng: đổi preToken lấy phiên quản trị nền tảng.
   *
   * Tra lại platform_admin Ở ĐÂY (không tin LoginResponse của bước 1): preToken
   * sống 5 phút, và người đó có thể vừa bị thu quyền trong 5 phút ấy.
   */
  async selectPlatform(preToken: string, ua?: string): Promise<PlatformSessionResponse> {
    const claims = await this.verifyPreToken(preToken);
    // 'dev' kiểm lại cờ ở đây: preToken sống 5 phút, cờ có thể vừa bị tắt.
    const hopLe = claims.amr === 'pwd' || (claims.amr === 'dev' && devLoginBat());
    if (!hopLe) throw new ForbiddenException('PLATFORM_REQUIRES_PASSWORD');
    const level = await this.platformLevelOf(claims.sub);
    if (!level) throw new ForbiddenException('NOT_A_PLATFORM_ADMIN');
    return this.issuePlatformSession(claims.sub, level, randomUUID(), ua);
  }

  async refresh(rawToken: string, ua?: string): Promise<SessionResponse | PlatformSessionResponse> {
    const row = await this.db
      .selectFrom('refresh_token')
      .select(['id', 'identity_id', 'tenant_id', 'family_id', 'expires_at', 'revoked_at', 'revoked_reason'])
      .where('token_hash', '=', this.hashToken(rawToken))
      .executeTakeFirst();

    if (!row) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');

    // Token đã bị thu hồi mà vẫn được dùng => nhiều khả năng đã bị đánh cắp.
    // Thu hồi CẢ HỌ token, buộc đăng nhập lại trên mọi thiết bị.
    let duaSongSong =
      row.revoked_at !== null &&
      row.revoked_reason === 'ROTATED' &&
      Date.now() - new Date(row.revoked_at).getTime() < REUSE_GRACE_MS;
    if (duaSongSong) {
      // Họ token đã bị đóng vì lý do khác (đăng xuất, nghi trộm, đổi mật khẩu)
      // thì vòng dung sai không được hồi sinh nó.
      const dong = await this.db
        .selectFrom('refresh_token')
        .select('id')
        .where('family_id', '=', row.family_id)
        .where('revoked_reason', 'in', ['REUSE_DETECTED', 'LOGOUT', 'PASSWORD_CHANGED'])
        .executeTakeFirst();
      if (dong) duaSongSong = false;
    }
    if (row.revoked_at && !duaSongSong) {
      await this.db
        .updateTable('refresh_token')
        .set({ revoked_at: new Date(), revoked_reason: 'REUSE_DETECTED' })
        .where('family_id', '=', row.family_id)
        .where('revoked_at', 'is', null)
        .execute();
      throw new UnauthorizedException('REFRESH_TOKEN_REUSED');
    }
    if (row.expires_at < new Date()) throw new UnauthorizedException('REFRESH_TOKEN_EXPIRED');

    let session: SessionResponse | PlatformSessionResponse;
    if (!row.tenant_id) {
      // Refresh token không gắn phòng = phiên nền tảng. Tra lại quyền MỖI lần
      // làm mới: thu quyền quản trị phải có hiệu lực trong một vòng access token.
      const level = await this.platformLevelOf(row.identity_id);
      if (!level) throw new ForbiddenException('NOT_A_PLATFORM_ADMIN');
      session = await this.issuePlatformSession(row.identity_id, level, row.family_id, ua);
    } else {
      const tenants = await this.tenantsOf(row.identity_id);
      const chosen = tenants.find((t) => t.tenantId === row.tenant_id);
      if (!chosen) throw new ForbiddenException('NOT_A_MEMBER_OF_TENANT');
      session = await this.issueSession(row.identity_id, chosen, row.family_id, ua);
    }
    // Chỉ đóng dấu lần xoay ĐẦU: lượt dùng lại trong vòng dung sai không được
    // kéo dài vòng đó thêm 30 giây nữa.
    await this.db
      .updateTable('refresh_token')
      .set({ revoked_at: new Date(), revoked_reason: 'ROTATED' })
      .where('id', '=', row.id)
      .where('revoked_at', 'is', null)
      .execute();
    return session;
  }

  async logout(rawToken: string, allDevices: boolean): Promise<void> {
    const row = await this.db
      .selectFrom('refresh_token')
      .select(['id', 'family_id', 'identity_id'])
      .where('token_hash', '=', this.hashToken(rawToken))
      .executeTakeFirst();
    if (!row) return;

    let q = this.db
      .updateTable('refresh_token')
      .set({ revoked_at: new Date(), revoked_reason: 'LOGOUT' })
      .where('revoked_at', 'is', null);
    q = allDevices
      ? q.where('identity_id', '=', row.identity_id)
      : q.where('family_id', '=', row.family_id);
    await q.execute();
  }

  // -------------------------------------------------------------------------

  private async platformLevelOf(identityId: string): Promise<PlatformLevel | null> {
    const row = await this.db
      .selectFrom('platform_admin')
      .select('level')
      .where('identity_id', '=', identityId)
      .executeTakeFirst();
    return (row?.level as PlatformLevel | undefined) ?? null;
  }

  private async tenantsOf(identityId: string): Promise<TenantOption[]> {
    const rows = await this.db
      .selectFrom('tenant_user as tu')
      .innerJoin('tenant as t', 't.id', 'tu.tenant_id')
      .select(['t.id as tenantId', 't.slug', 't.name', 'tu.role'])
      .where('tu.identity_id', '=', identityId)
      .where('tu.status', '=', 'ACTIVE')
      // SUSPENDED vẫn vào được, ở chế độ CHỈ ĐỌC (TenantStatusGuard): chủ phòng
      // phải vào được để thấy hoá đơn dịch vụ và trả tiền. Khoá cả cửa là khoá
      // luôn đường thoát. CLOSED thì không.
      .where('t.status', 'in', ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'])
      .execute();

    const grouped = new Map<string, TenantOption>();
    for (const r of rows) {
      const cur = grouped.get(r.tenantId);
      if (cur) cur.roles.push(r.role as TenantRole);
      else
        grouped.set(r.tenantId, {
          tenantId: r.tenantId,
          slug: String(r.slug),
          name: r.name,
          roles: [r.role as TenantRole],
        });
    }
    return [...grouped.values()];
  }

  private async issuePlatformSession(
    identityId: string,
    level: PlatformLevel,
    familyId: string,
    ua?: string,
  ): Promise<PlatformSessionResponse> {
    const ttlSeconds = Number(this.cfg.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    const accessToken = await this.jwt.signAsync(
      { sub: identityId, scope: 'platform', pa: level } satisfies Omit<PlatformTokenClaims, 'iat' | 'exp'>,
      { secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: ttlSeconds },
    );

    // Phiên nền tảng sống NGẮN hơn phiên phòng tập: 1 ngày thay vì 30 — người
    // cầm nó nhìn được mọi phòng tập. tenant_id NULL là dấu hiệu của nó.
    const refreshToken = randomUUID() + randomUUID();
    await this.db
      .insertInto('refresh_token')
      .values({
        identity_id: identityId,
        tenant_id: null,
        token_hash: this.hashToken(refreshToken),
        family_id: familyId,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000),
        user_agent: ua ?? null,
      })
      .execute();

    const idn = await this.db
      .selectFrom('identity')
      .select('full_name')
      .where('id', '=', identityId)
      .executeTakeFirstOrThrow();
    return { accessToken, refreshToken, expiresIn: ttlSeconds, identityId, fullName: idn.full_name, level };
  }

  private async issueSession(
    identityId: string,
    tenant: TenantOption,
    familyId: string,
    ua?: string,
  ): Promise<SessionResponse> {
    // memberId / trainerId nằm trong claim để không phải tra lại mỗi request.
    // app_auth chỉ được cấp SELECT trên ĐÚNG ba cột của hai bảng này (0006).
    const [member, trainer] = await Promise.all([
      this.db
        .selectFrom('member')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('identity_id', '=', identityId)
        .executeTakeFirst(),
      this.db
        .selectFrom('trainer')
        .select('id')
        .where('tenant_id', '=', tenant.tenantId)
        .where('identity_id', '=', identityId)
        .executeTakeFirst(),
    ]);

    const payload: Omit<AccessTokenClaims, 'iat' | 'exp'> = {
      sub: identityId,
      tid: tenant.tenantId,
      roles: tenant.roles,
      ...(member ? { mid: member.id } : {}),
      ...(trainer ? { trid: trainer.id } : {}),
    };

    // TTL tính bằng GIÂY (số), không phải chuỗi '15m': giá trị này vừa đi vào
    // token vừa được trả cho client ở `expiresIn`. Hai nguồn khác nhau cho cùng
    // một con số là hai nguồn sẽ lệch — bản trước đã lệch đúng như vậy.
    const ttlSeconds = Number(this.cfg.get('JWT_ACCESS_TTL_SECONDS') ?? 900);
    const refreshDays = Number(this.cfg.get('JWT_REFRESH_TTL_DAYS') ?? 30);

    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'),
      expiresIn: ttlSeconds,
    });

    const refreshToken = randomUUID() + randomUUID();
    const expiresAt = new Date(Date.now() + refreshDays * 24 * 3600 * 1000);
    await this.db
      .insertInto('refresh_token')
      .values({
        identity_id: identityId,
        tenant_id: tenant.tenantId,
        token_hash: this.hashToken(refreshToken),
        family_id: familyId,
        expires_at: expiresAt,
        user_agent: ua ?? null,
      })
      .execute();

    const fullName = await this.db
      .selectFrom('identity')
      .select('full_name')
      .where('id', '=', identityId)
      .executeTakeFirstOrThrow();

    return {
      accessToken,
      refreshToken,
      expiresIn: ttlSeconds,
      tenant,
      identityId,
      fullName: fullName.full_name,
    };
  }
}
