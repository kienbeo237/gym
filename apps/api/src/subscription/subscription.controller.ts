import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { CreatePlanRequest, type PlanRequestInfo, type SubscriptionOverview, type TenantStanding } from '@pt/contracts';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { SubscriptionService } from './subscription.service';

@Controller('subscription')
export class SubscriptionController {
  constructor(private readonly svc: SubscriptionService) {}

  /**
   * Dải trạng thái trên đầu màn quản lý: mọi nhân viên cần biết phòng đang bị
   * khoá (vì sao nút "Lưu" không chạy). Số tiền và tài khoản ngân hàng thì
   * không — endpoint dưới.
   */
  @Get('standing')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  standing(): Promise<TenantStanding> {
    return this.svc.standing();
  }

  @Get()
  @Roles('OWNER', 'ADMIN')
  overview(): Promise<SubscriptionOverview> {
    return this.svc.overview();
  }

  /** Chỉ CHỦ PHÒNG: đổi gói là đổi số tiền phòng phải trả hằng tháng. */
  @Post('plan-request')
  @Roles('OWNER')
  requestPlanChange(@Body(new ZodPipe(CreatePlanRequest)) body: CreatePlanRequest): Promise<PlanRequestInfo> {
    return this.svc.requestPlanChange(body);
  }

  @Delete('plan-request')
  @HttpCode(204)
  @Roles('OWNER')
  cancelPlanRequest(): Promise<void> {
    return this.svc.cancelPlanRequest();
  }
}
