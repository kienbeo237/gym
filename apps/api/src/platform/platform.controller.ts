import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import {
  AddPlatformAdminRequest,
  ChangeAdminLevelRequest,
  ChangePlanRequest,
  DecidePlanRequest,
  ResolveBankTxnRequest,
  ConfirmPaymentRequest,
  CreateTenantRequest,
  ExtendTrialRequest,
  IssueInvoiceRequest,
  SettleNoteRequest,
  TenantStatusRequest,
  type PlatformTokenClaims,
} from '@pt/contracts';
import { z } from 'zod';
import { Platform } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import type { PlatformActor } from './platform-db.service';
import { PlatformService } from './platform.service';

type Req = { user: PlatformTokenClaims; ip?: string; headers: Record<string, string | undefined> };

/** Người thao tác lấy từ token đã ký — không bao giờ từ body hay query. */
function actor(req: Req): PlatformActor {
  const ip = (req.ip ?? '').replace(/^::ffff:/, '');
  return { identityId: req.user.sub, ip: /^[0-9a-f:.]+$/i.test(ip) ? ip : null };
}

const TenantStatusFilter = z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CLOSED']).optional();
const InvoiceStatusFilter = z.enum(['PENDING', 'PAID', 'WAIVED', 'VOID']).optional();
const PlanRequestFilter = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional();
const BankView = z.enum(['OPEN', 'ALL']).default('OPEN');

/**
 * Quản trị nền tảng. @Platform() ở class: MỌI route ở đây chỉ nhận token phiên
 * nền tảng, mặc định cấp SUPPORT (xem). Route ghi nâng lên OPS / SUPER.
 *
 * Cấp trong token chỉ là lớp gác thô; PlatformDb kiểm lại cấp ĐANG CÓ trong
 * CSDL ở mỗi thao tác.
 */
@Controller('platform')
@Platform()
export class PlatformController {
  constructor(private readonly svc: PlatformService) {}

  @Get('overview')
  overview(@Req() req: Req) {
    return this.svc.overview(actor(req));
  }

  @Get('plans')
  plans(@Req() req: Req) {
    return this.svc.plans(actor(req));
  }

  @Get('tenants')
  tenants(@Req() req: Req, @Query('q') q?: string, @Query('status', new ZodPipe(TenantStatusFilter)) status?: string) {
    return this.svc.tenants(actor(req), { q, status });
  }

  @Post('tenants')
  @Platform('OPS')
  createTenant(@Req() req: Req, @Body(new ZodPipe(CreateTenantRequest)) body: CreateTenantRequest) {
    return this.svc.createTenant(actor(req), body);
  }

  @Get('tenants/:id')
  tenant(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.tenant(actor(req), id);
  }

  @Patch('tenants/:id/plan')
  @Platform('OPS')
  changePlan(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ChangePlanRequest)) body: ChangePlanRequest) {
    return this.svc.changePlan(actor(req), id, body);
  }

  @Post('tenants/:id/extend-trial')
  @HttpCode(200)
  @Platform('OPS')
  extendTrial(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ExtendTrialRequest)) body: ExtendTrialRequest) {
    return this.svc.extendTrial(actor(req), id, body);
  }

  @Post('tenants/:id/suspend')
  @HttpCode(200)
  @Platform('OPS')
  suspend(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TenantStatusRequest)) body: TenantStatusRequest) {
    return this.svc.suspend(actor(req), id, body.note);
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(200)
  @Platform('OPS')
  reactivate(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TenantStatusRequest)) body: TenantStatusRequest) {
    return this.svc.reactivate(actor(req), id, body.note);
  }

  @Post('tenants/:id/close')
  @HttpCode(200)
  @Platform('SUPER')
  close(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(TenantStatusRequest)) body: TenantStatusRequest) {
    return this.svc.close(actor(req), id, body.note);
  }

  @Post('tenants/:id/invoices')
  @Platform('OPS')
  issueInvoice(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(IssueInvoiceRequest)) body: IssueInvoiceRequest) {
    return this.svc.issueInvoice(actor(req), id, body);
  }

  @Get('invoices')
  invoices(@Req() req: Req, @Query('status', new ZodPipe(InvoiceStatusFilter)) status?: string, @Query('q') q?: string) {
    return this.svc.invoices(actor(req), { status, q });
  }

  @Post('invoices/:id/confirm')
  @HttpCode(200)
  @Platform('OPS')
  confirm(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ConfirmPaymentRequest)) body: ConfirmPaymentRequest) {
    return this.svc.confirm(actor(req), id, body);
  }

  @Post('invoices/:id/waive')
  @HttpCode(200)
  @Platform('OPS')
  waive(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SettleNoteRequest)) body: SettleNoteRequest) {
    return this.svc.waive(actor(req), id, body.note);
  }

  @Post('invoices/:id/void')
  @HttpCode(200)
  @Platform('OPS')
  void(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SettleNoteRequest)) body: SettleNoteRequest) {
    return this.svc.void(actor(req), id, body.note);
  }

  // ---- Yêu cầu đổi gói --------------------------------------------------------

  @Get('plan-requests')
  planRequests(@Req() req: Req, @Query('status', new ZodPipe(PlanRequestFilter)) status?: string) {
    return this.svc.planRequests(actor(req), status);
  }

  @Post('plan-requests/:id/approve')
  @HttpCode(200)
  @Platform('OPS')
  approvePlanRequest(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DecidePlanRequest)) body: DecidePlanRequest) {
    return this.svc.approvePlanRequest(actor(req), id, body.note);
  }

  @Post('plan-requests/:id/reject')
  @HttpCode(200)
  @Platform('OPS')
  rejectPlanRequest(@Req() req: Req, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SettleNoteRequest)) body: SettleNoteRequest) {
    return this.svc.rejectPlanRequest(actor(req), id, body.note);
  }

  // ---- Giao dịch ngân hàng (webhook) -------------------------------------------

  @Get('bank-txns')
  bankTxns(@Req() req: Req, @Query('view', new ZodPipe(BankView)) view: 'OPEN' | 'ALL') {
    return this.svc.bankTxns(actor(req), { view });
  }

  @Post('bank-txns/:id/resolve')
  @HttpCode(200)
  @Platform('OPS')
  resolveBankTxn(
    @Req() req: Req,
    @Param('id', new ZodPipe(z.string().regex(/^\d+$/))) id: string,
    @Body(new ZodPipe(ResolveBankTxnRequest)) body: ResolveBankTxnRequest,
  ) {
    return this.svc.resolveBankTxn(actor(req), id, body.note);
  }

  // ---- Tài khoản quản trị nền tảng: CHỈ SUPER -----------------------------------

  @Get('admins')
  @Platform('SUPER')
  admins(@Req() req: Req) {
    return this.svc.admins(actor(req));
  }

  @Post('admins')
  @Platform('SUPER')
  addAdmin(@Req() req: Req, @Body(new ZodPipe(AddPlatformAdminRequest)) body: AddPlatformAdminRequest) {
    return this.svc.addAdmin(actor(req), body);
  }

  @Patch('admins/:identityId')
  @Platform('SUPER')
  changeAdminLevel(
    @Req() req: Req,
    @Param('identityId', ParseUUIDPipe) identityId: string,
    @Body(new ZodPipe(ChangeAdminLevelRequest)) body: ChangeAdminLevelRequest,
  ) {
    return this.svc.changeAdminLevel(actor(req), identityId, body.level);
  }

  @Delete('admins/:identityId')
  @HttpCode(204)
  @Platform('SUPER')
  async revokeAdmin(@Req() req: Req, @Param('identityId', ParseUUIDPipe) identityId: string): Promise<void> {
    await this.svc.revokeAdmin(actor(req), identityId);
  }

  @Get('audit')
  audit(
    @Req() req: Req,
    @Query('tenantId', new ZodPipe(z.string().uuid().optional())) tenantId?: string,
    @Query('page', new ZodPipe(z.coerce.number().int().min(1).default(1))) page = 1,
  ) {
    return this.svc.audit(actor(req), { tenantId, page, size: 50 });
  }
}
