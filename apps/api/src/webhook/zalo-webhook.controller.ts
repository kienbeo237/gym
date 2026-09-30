import { BadRequestException, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../common/auth.guard';
import { ZaloWebhookService } from '../zalo/zalo-webhook.service';

/**
 * Báo phát ZNS từ Zalo. Người gọi là máy chủ Zalo — xác thực bằng chữ ký trên
 * thân thô (main.ts bật rawBody), khoá riêng của từng phòng.
 */
@Controller('webhooks')
export class ZaloWebhookController {
  constructor(private readonly svc: ZaloWebhookService) {}

  @Public()
  @Post('zalo/:tenantId')
  @HttpCode(200)
  zalo(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Headers('x-zevent-signature') chuKy: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!req.rawBody) throw new BadRequestException('EMPTY_BODY');
    return this.svc.nhan(tenantId, req.rawBody, chuKy);
  }
}
