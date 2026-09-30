import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';
import { Scheduler } from './worker/scheduler.service';
import { assertCauHinhSanSang } from './common/config-guard';

/**
 * Tiến trình WORKER — tách khỏi API.
 *
 * Gửi tin tới Zalo, chạy chiến dịch, làm mới token, dọn tệp. Tách tiến trình vì
 * hai lý do cụ thể:
 *   - Zalo chậm / treo không được làm chậm request của người dùng
 *   - scale riêng: chạy 2 bản API sau load balancer không có nghĩa là muốn 2
 *     bản gửi tin (dù chạy 2 bản vẫn đúng — xem Scheduler)
 *
 * Cùng image với API, khác lệnh chạy: `node dist/worker.js`.
 */
async function bootstrap(): Promise<void> {
  assertCauHinhSanSang();
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  app.get(Scheduler).start();
  new Logger('worker').log('Worker đã khởi động');
}

void bootstrap();
