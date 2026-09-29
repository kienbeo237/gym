import {
  BadRequestException,
  Inject,
  Injectable,
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
  SessionResponse,
  TenantOption,
  TenantRole,
  PreTokenClaims,
  AccessTokenClaims,
} from '@pt/contracts';
import { DB_AUTH } from '../db/database.module';
import { RateLimitService } from '../redis/rate-limit.service';
import { globalKey, phoneKeyPart } from '../redis/redis-keys';

const sha256 = (v: string): string => createHash('sha256').update(v).digest('hex');

/**
 * Xác thực chạy TRƯỚC khi có ngữ cảnh tenant, nên nó là nơi DUY NHẤT dùng
 * kết nối app_auth (BYPASSRLS, quyền hẹp). Mọi thứ khác đi qua TenantDb.
 *
 * Hai bước có chủ đích: một số điện thoại có thể là hội viên ở phòng A và PT ở
 * phòng B. Hỏi "vào phòng nào" rồi mới ký token mang tenantId.
 */
@Injectable()
export class AuthService {
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
      .select(['id', 'full_name', 'password_hash', 'status'])
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

    return this.completeAuthentication(identity.id);
  }

  /**
   * Kết thúc bước 1 sau khi đã xác thực được NGƯỜI, bằng bất kỳ cách nào —
   * mật khẩu hoặc OTP. Tách ra để hai đường đăng nhập cho ra đúng cùng một kết
   * quả: cùng preToken, cùng danh sách phòng, cùng thời hạn.
   *
   * Hai đường tự dựng preToken riêng là hai chỗ để lệch nhau về sau (thời hạn,
   * claim thiếu), và lệch ở đây là lệch về bảo mật.
   */
  async completeAuthentication(identityId: string): Promise<LoginResponse> {
    const identity = await this.db
      .selectFrom('identity')
      .select(['id', 'full_name'])
      .where('id', '=', identityId)
      .executeTakeFirstOrThrow();

    const tenants = await this.tenantsOf(identity.id);
    if (tenants.length === 0) throw new ForbiddenException('NO_TENANT_MEMBERSHIP');

    const preToken = await this.jwt.signAsync(
      { sub: identity.id, stage: 'SELECT_TENANT' } satisfies Omit<PreTokenClaims, 'iat' | 'exp'>,
      { secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: '5m' },
    );

    return { preToken, identityId: identity.id, fullName: identity.full_name, tenants };
  }

  async selectTenant(preToken: string, tenantId: string, ua?: string): Promise<SessionResponse> {
    let claims: PreTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<PreTokenClaims>(preToken, {
        secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('INVALID_PRE_TOKEN');
    }
    if (claims.stage !== 'SELECT_TENANT') throw new UnauthorizedException('INVALID_PRE_TOKEN');

    const tenants = await this.tenantsOf(claims.sub);
    const chosen = tenants.find((t) => t.tenantId === tenantId);
    if (!chosen) throw new ForbiddenException('NOT_A_MEMBER_OF_TENANT');

    return this.issueSession(claims.sub, chosen, randomUUID(), ua);
  }

  async refresh(rawToken: string, ua?: string): Promise<SessionResponse> {
    const row = await this.db
      .selectFrom('refresh_token')
      .select(['id', 'identity_id', 'tenant_id', 'family_id', 'expires_at', 'revoked_at'])
      .where('token_hash', '=', this.hashToken(rawToken))
      .executeTakeFirst();

    if (!row) throw new UnauthorizedException('INVALID_REFRESH_TOKEN');

    // Token đã bị thu hồi mà vẫn được dùng => nhiều khả năng đã bị đánh cắp.
    // Thu hồi CẢ HỌ token, buộc đăng nhập lại trên mọi thiết bị.
    if (row.revoked_at) {
      await this.db
        .updateTable('refresh_token')
        .set({ revoked_at: new Date(), revoked_reason: 'REUSE_DETECTED' })
        .where('family_id', '=', row.family_id)
        .where('revoked_at', 'is', null)
        .execute();
      throw new UnauthorizedException('REFRESH_TOKEN_REUSED');
    }
    if (row.expires_at < new Date()) throw new UnauthorizedException('REFRESH_TOKEN_EXPIRED');
    if (!row.tenant_id) throw new UnauthorizedException('TENANT_NOT_SELECTED');

    const tenants = await this.tenantsOf(row.identity_id);
    const chosen = tenants.find((t) => t.tenantId === row.tenant_id);
    if (!chosen) throw new ForbiddenException('NOT_A_MEMBER_OF_TENANT');

    const session = await this.issueSession(row.identity_id, chosen, row.family_id, ua);
    await this.db
      .updateTable('refresh_token')
      .set({ revoked_at: new Date(), revoked_reason: 'ROTATED' })
      .where('id', '=', row.id)
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

  private async tenantsOf(identityId: string): Promise<TenantOption[]> {
    const rows = await this.db
      .selectFrom('tenant_user as tu')
      .innerJoin('tenant as t', 't.id', 'tu.tenant_id')
      .select(['t.id as tenantId', 't.slug', 't.name', 'tu.role'])
      .where('tu.identity_id', '=', identityId)
      .where('tu.status', '=', 'ACTIVE')
      .where('t.status', 'in', ['TRIAL', 'ACTIVE', 'PAST_DUE'])
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
