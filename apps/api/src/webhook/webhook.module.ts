import { Module } from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { PlatformModule } from '../platform/platform.module';
import { SepayWebhookController } from './sepay.controller';
import { ZaloWebhookController } from './zalo-webhook.controller';

/** Webhook từ bên thứ ba (ngân hàng, Zalo). Xác thực bằng khoá riêng của từng bên. */
@Module({
  imports: [PlatformModule, NotificationModule],
  controllers: [SepayWebhookController, ZaloWebhookController],
})
export class WebhookModule {}
