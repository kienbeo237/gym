import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import {
  CreateCampaignRequest,
  ListOutboxQuery,
  SaveZaloCredentialsRequest,
  SaveZaloWebhookSecretRequest,
  TemplateCode,
  UpdateCampaignRequest,
  UpdateZnsTemplateRequest,
  ZaloCallbackRequest,
} from '@pt/contracts';
import { z } from 'zod';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { ZaloOaService } from '../zalo/zalo-oa.service';
import { NotificationService } from './notification.service';

const OutboxId = z.string().regex(/^\d{1,18}$/);

/**
 * Kết nối Zalo và cấu hình mẫu: CHỈ chủ phòng / quản lý. Đây là nơi nhập
 * secret của OA — lễ tân không cần và không nên chạm tới.
 */
@Controller('zalo')
@Roles('OWNER', 'ADMIN')
export class ZaloController {
  constructor(private readonly oa: ZaloOaService) {}

  @Get('oa')
  info() {
    return this.oa.info();
  }

  @Put('oa/credentials')
  saveCredentials(@Body(new ZodPipe(SaveZaloCredentialsRequest)) dto: SaveZaloCredentialsRequest) {
    return this.oa.saveCredentials(dto);
  }

  @Put('oa/webhook-secret')
  saveWebhookSecret(@Body(new ZodPipe(SaveZaloWebhookSecretRequest)) dto: SaveZaloWebhookSecretRequest) {
    return this.oa.saveWebhookSecret(dto);
  }

  @Post('oa/connect')
  connect() {
    return this.oa.startConnect();
  }

  @Post('oa/callback')
  callback(@Body(new ZodPipe(ZaloCallbackRequest)) dto: ZaloCallbackRequest) {
    return this.oa.completeConnect(dto);
  }

  @Delete('oa')
  disconnect() {
    return this.oa.disconnect();
  }

  @Get('templates')
  templates() {
    return this.oa.listTemplates();
  }

  @Put('templates/:code')
  updateTemplate(
    @Param('code', new ZodPipe(TemplateCode)) code: TemplateCode,
    @Body(new ZodPipe(UpdateZnsTemplateRequest)) dto: UpdateZnsTemplateRequest,
  ) {
    return this.oa.updateTemplate(code, dto);
  }
}

@Controller('notifications')
export class NotificationController {
  constructor(private readonly svc: NotificationService) {}

  // Lễ tân xem được: họ là người khách gọi tới hỏi "sao em không nhận tin".
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  list(@Query(new ZodPipe(ListOutboxQuery)) q: ListOutboxQuery) {
    return this.svc.listOutbox(q);
  }

  @Get('stats')
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  stats() {
    return this.svc.stats();
  }

  @Post(':id/retry')
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  retry(@Param('id', new ZodPipe(OutboxId)) id: string) {
    return this.svc.retry(id);
  }
}

@Controller('campaigns')
@Roles('OWNER', 'ADMIN')
export class CampaignController {
  constructor(private readonly svc: NotificationService) {}

  @Get()
  list() {
    return this.svc.listCampaigns();
  }

  @Post()
  create(@Body(new ZodPipe(CreateCampaignRequest)) dto: CreateCampaignRequest) {
    return this.svc.createCampaign(dto);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(UpdateCampaignRequest)) dto: UpdateCampaignRequest,
  ) {
    return this.svc.updateCampaign(id, dto);
  }

  @Get(':id/preview')
  preview(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.preview(id);
  }

  @Post('run')
  run() {
    return this.svc.runNow();
  }
}
