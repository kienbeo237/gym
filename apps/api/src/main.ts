import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { assertCauHinhSanSang } from './common/config-guard';

async function bootstrap(): Promise<void> {
  // Kiểm TRƯỚC khi dựng ứng dụng: thà không khởi động còn hơn khởi động với
  // bí mật mà cả thế giới đọc được trong .env.example.
  assertCauHinhSanSang();

  const app = await NestFactory.create(AppModule, {
    bufferLogs: false,
    // Webhook Zalo ký trên THÂN THÔ của request — JSON đã parse rồi stringify lại
    // không còn khớp từng byte.
    rawBody: true,
  });
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','),
    credentials: true,
  });
  app.enableShutdownHooks();

  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port, '0.0.0.0');
  new Logger('bootstrap').log(`API chay tai http://localhost:${port}/api`);
}

void bootstrap();
