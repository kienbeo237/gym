import { Body, Controller, Headers, HttpCode, Post, Req, UsePipes } from '@nestjs/common';
import {
  LoginRequest,
  SelectTenantRequest,
  type LoginResponse,
  type SessionResponse,
} from '@pt/contracts';
import { AuthService } from './auth.service';
import { Public } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Bước 1: xác thực người. Chưa mở được dữ liệu nghiệp vụ nào. */
  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodPipe(LoginRequest))
  login(@Body() body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  /** Bước 2: chọn phòng tập -> token mang tenantId, từ đây RLS mới có đầu vào. */
  @Public()
  @Post('select-tenant')
  @HttpCode(200)
  selectTenant(
    @Headers('authorization') authHeader: string | undefined,
    @Body(new ZodPipe(SelectTenantRequest)) body: SelectTenantRequest,
    @Req() req: { headers: Record<string, string | undefined> },
  ): Promise<SessionResponse> {
    const preToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return this.auth.selectTenant(preToken, body.tenantId, req.headers['user-agent']);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body() body: { refreshToken: string },
    @Req() req: { headers: Record<string, string | undefined> },
  ): Promise<SessionResponse> {
    return this.auth.refresh(body.refreshToken, req.headers['user-agent']);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refreshToken: string; allDevices?: boolean }): Promise<void> {
    await this.auth.logout(body.refreshToken, body.allDevices === true);
  }
}
