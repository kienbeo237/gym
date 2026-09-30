import { Module } from '@nestjs/common';
import { ZaloApi } from '../zalo/zalo-api';
import { ZaloOaService } from '../zalo/zalo-oa.service';
import { ZaloWebhookService } from '../zalo/zalo-webhook.service';
import { SmsApi } from '../sms/sms-api';
import { CampaignRunner } from './campaign-runner.service';
import { CampaignController, NotificationController, ZaloController } from './notification.controller';
import { NotificationService } from './notification.service';
import { OutboxDispatcher } from './outbox-dispatcher.service';

/**
 * Gửi tin + Zalo OA + chiến dịch. Dùng ở HAI tiến trình:
 *   API     controller (cài đặt, xem hộp thư, chạy thử chiến dịch)
 *   worker  OutboxDispatcher + CampaignRunner + làm mới token (src/worker.ts)
 */
@Module({
  controllers: [ZaloController, NotificationController, CampaignController],
  providers: [ZaloApi, ZaloOaService, ZaloWebhookService, SmsApi, OutboxDispatcher, CampaignRunner, NotificationService],
  exports: [ZaloApi, ZaloOaService, ZaloWebhookService, SmsApi, OutboxDispatcher, CampaignRunner],
})
export class NotificationModule {}
