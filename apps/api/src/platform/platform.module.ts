import { Module } from '@nestjs/common';
import { PlatformController } from './platform.controller';
import { PlatformDb } from './platform-db.service';
import { PlatformService } from './platform.service';

/**
 * Chỉ PlatformDb — cho worker (job vòng đời thuê bao), không kéo theo
 * controller hay nghiệp vụ quản trị nào.
 */
@Module({ providers: [PlatformDb], exports: [PlatformDb] })
export class PlatformDbModule {}

/** Quản trị nền tảng: /api/platform/*. */
@Module({
  imports: [PlatformDbModule],
  controllers: [PlatformController],
  providers: [PlatformService],
  // Cho WebhookModule: webhook ngân hàng đi qua PlatformService, không cầm PlatformDb.
  exports: [PlatformService],
})
export class PlatformModule {}
