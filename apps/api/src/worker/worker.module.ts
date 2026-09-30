import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from '../db/database.module';
import { RedisModule } from '../redis/redis.module';
import { CommonModule } from '../common/common.module';
import { NotificationModule } from '../notification/notification.module';
import { StorageModule } from '../storage/storage.module';
import { PlatformDbModule } from '../platform/platform.module';
import { AttendanceModule } from '../attendance/attendance.module';
import { CommissionModule } from '../commission/commission.module';
import { Scheduler } from './scheduler.service';

/** Module của tiến trình worker — không HTTP, không guard, không controller nào được phục vụ. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['../../.env'] }),
    DatabaseModule,
    RedisModule,
    CommonModule,
    NotificationModule,
    StorageModule,
    PlatformDbModule,
    // CommissionModule là @Global trong app; worker phải tự nạp vì Attendance cần nó.
    CommissionModule,
    AttendanceModule,
  ],
  providers: [Scheduler],
})
export class WorkerModule {}
