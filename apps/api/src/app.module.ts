import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { DatabaseModule } from './db/database.module';
import { RedisModule } from './redis/redis.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, TenantContextInterceptor } from './common/auth.guard';
import { TenantStatusGuard } from './common/tenant-status.guard';
import { AuthModule } from './auth/auth.module';
import { MemberModule } from './member/member.module';
import { TrainerModule } from './trainer/trainer.module';
import { PackageModule } from './package/package.module';
import { StorageModule } from './storage/storage.module';
import { CommissionModule } from './commission/commission.module';
import { SaleModule } from './sale/sale.module';
import { BillingModule } from './billing/billing.module';
import { AttendanceModule } from './attendance/attendance.module';
import { ReportModule } from './report/report.module';
import { MeModule } from './me/me.module';
import { NotificationModule } from './notification/notification.module';
import { HealthModule } from './health/health.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { PlatformModule } from './platform/platform.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [
    // .env nằm ở gốc monorepo, không nằm trong apps/api.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
    JwtModule.register({ global: true }),
    DatabaseModule,
    RedisModule,
    CommonModule,
    AuthModule,
    MemberModule,
    TrainerModule,
    PackageModule,
    StorageModule,
    CommissionModule,
    SaleModule,
    BillingModule,
    AttendanceModule,
    ReportModule,
    MeModule,
    NotificationModule,
    HealthModule,
    SubscriptionModule,
    PlatformModule,
    WebhookModule,
  ],
  providers: [
    // Mặc định là ĐÓNG: mọi route đều cần token, mở ra bằng @Public().
    // Ngược lại (mặc định mở, đóng bằng decorator) thì mỗi route mới quên gắn
    // decorator là một lỗ hổng, và không gì nhắc.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // SAU JwtAuthGuard: cần req.user. Phòng tạm khoá = chỉ đọc, phòng đóng = không gì.
    { provide: APP_GUARD, useClass: TenantStatusGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
})
export class AppModule {}
