import { Body, Controller, Headers, HttpCode, Post, Req, UsePipes } from '@nestjs/common';
import {
  ChangePasswordRequest,
  LoginRequest,
  OtpRequest,
  OtpVerifyRequest,
  SelectTenantRequest,
  type LoginResponse,
  type OtpRequestResponse,
  type PlatformSessionResponse,
  type SessionResponse,
} from '@pt/contracts';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { Public } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly otp: OtpService,
  ) {}

  /** Bước 1 (nhân viên): xác thực bằng mật khẩu. */
  @Public()
  @Post('login')
  @HttpCode(200)
  @UsePipes(new ZodPipe(LoginRequest))
  login(@Body() body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body);
  }

  /**
   * Bước 1 (hội viên): gửi mã OTP.
   *
   * Luôn trả `{sent: true}` kể cả khi số điện thoại không có trong hệ thống —
   * trả lỗi khác nhau là biến endpoint này thành công cụ dò danh sách khách hàng.
   */
  @Public()
  @Post('otp/request')
  @HttpCode(200)
  requestOtp(@Body(new ZodPipe(OtpRequest)) body: OtpRequest): Promise<OtpRequestResponse> {
    return this.otp.request(body.phone);
  }

  /** Bước 1 (hội viên): xác minh mã -> preToken, giống hệt đường mật khẩu. */
  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @Body(new ZodPipe(OtpVerifyRequest)) body: OtpVerifyRequest,
  ): Promise<LoginResponse> {
    const identityId = await this.otp.verify(body.phone, body.code);
    return this.auth.completeAuthentication(identityId, 'otp');
  }

  /**
   * Bước 1 (CHỈ máy lập trình): chỉ số điện thoại -> preToken. Tắt (404) trừ
   * khi DEV_LOGIN_BYPASS=1 và NODE_ENV khác production — xem devLoginBat().
   */
  @Public()
  @Post('dev-login')
  @HttpCode(200)
  devLogin(@Body(new ZodPipe(OtpRequest)) body: OtpRequest): Promise<LoginResponse> {
    return this.auth.devLogin(body.phone);
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

  /**
   * Bước 2, nhánh quản trị nền tảng: preToken (chỉ từ đăng nhập MẬT KHẨU) -> phiên
   * không mang tenant, chỉ mở được route @Platform().
   */
  @Public()
  @Post('select-platform')
  @HttpCode(200)
  selectPlatform(
    @Headers('authorization') authHeader: string | undefined,
    @Req() req: { headers: Record<string, string | undefined> },
  ): Promise<PlatformSessionResponse> {
    const preToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return this.auth.selectPlatform(preToken, req.headers['user-agent']);
  }

  /**
   * Đăng nhập bằng mật khẩu tạm -> đặt mật khẩu mới. preToken (stage
   * CHANGE_PASSWORD) chỉ mở được đúng route này. Trả kết quả bước 1 như đăng
   * nhập thường, người dùng đi tiếp bước chọn phòng.
   */
  @Public()
  @Post('change-password')
  @HttpCode(200)
  changePassword(
    @Headers('authorization') authHeader: string | undefined,
    @Body(new ZodPipe(ChangePasswordRequest)) body: ChangePasswordRequest,
  ): Promise<LoginResponse> {
    const preToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    return this.auth.changePassword(preToken, body.newPassword);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  refresh(
    @Body() body: { refreshToken: string },
    @Req() req: { headers: Record<string, string | undefined> },
  ): Promise<SessionResponse | PlatformSessionResponse> {
    return this.auth.refresh(body.refreshToken, req.headers['user-agent']);
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Body() body: { refreshToken: string; allDevices?: boolean }): Promise<void> {
    await this.auth.logout(body.refreshToken, body.allDevices === true);
  }
}
