import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type NestInterceptor,
  type CallHandler,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import type { AccessTokenClaims, TenantRole } from '@pt/contracts';
import { requestContext, type RequestContext } from './tenant-context';

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Gác theo vai trò. Đây là lớp THÔ — phạm vi dữ liệu do RLS + service lo. */
export const Roles = (...roles: TenantRole[]) => SetMetadata(ROLES, roles);

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly cfg: ConfigService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('MISSING_TOKEN');

    let claims: AccessTokenClaims;
    try {
      claims = await this.jwt.verifyAsync<AccessTokenClaims>(header.slice(7), {
        secret: this.cfg.getOrThrow('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('INVALID_TOKEN');
    }
    if (!claims.tid) {
      // Đây là preToken của bước 1. Nó cố ý không mở được dữ liệu nghiệp vụ nào.
      throw new UnauthorizedException('TENANT_NOT_SELECTED');
    }

    // Subdomain chỉ là GỢI Ý cho giao diện. Lệch với token thì từ chối, tuyệt
    // đối không âm thầm chuyển sang tenant của subdomain.
    const slugHint: string | undefined = req.headers?.['x-tenant-slug'];
    req.tenantSlugHint = slugHint;

    req.user = claims;

    const required = this.reflector.getAllAndOverride<TenantRole[]>(ROLES, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (required?.length && !required.some((r) => claims.roles.includes(r))) {
      throw new ForbiddenException('ROLE_NOT_ALLOWED');
    }
    return true;
  }
}

/**
 * Nạp ngữ cảnh vào AsyncLocalStorage, bọc quanh toàn bộ việc xử lý request.
 *
 * Phải là INTERCEPTOR chứ không phải guard: guard chỉ trả true/false, không bọc
 * được lời gọi tiếp theo, nên `requestContext.run()` đặt ở guard sẽ kết thúc
 * trước khi controller chạy.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest();
    const claims: AccessTokenClaims | undefined = req.user;
    const requestId: string = req.headers?.['x-request-id'] ?? randomUUID();
    ctx.switchToHttp().getResponse().setHeader('x-request-id', requestId);

    if (!claims?.tid) return next.handle();

    const store: RequestContext = {
      tenantId: claims.tid,
      identityId: claims.sub,
      roles: claims.roles ?? [],
      requestId,
      ...(claims.mid ? { memberId: claims.mid } : {}),
      ...(claims.trid ? { trainerId: claims.trid } : {}),
    };

    return new Observable((subscriber) => {
      requestContext.run(store, () => {
        next.handle().subscribe({
          next: (v) => subscriber.next(v),
          error: (e) => subscriber.error(e),
          complete: () => subscriber.complete(),
        });
      });
    });
  }
}
