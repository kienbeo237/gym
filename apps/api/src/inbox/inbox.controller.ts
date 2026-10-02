import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import type { InboxList } from '@pt/contracts';
import { Roles } from '../common/auth.guard';
import { InboxService } from './inbox.service';

/** Chuông thông báo của nhân viên. Hội viên chưa có — họ nhận nhắc lịch qua Zalo. */
@Controller('inbox')
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  list(): Promise<InboxList> {
    return this.inbox.list();
  }

  // Khai TRƯỚC ':id/read' cho dễ đọc; hai đường không đụng nhau.
  @Post('read-all')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  readAll(): Promise<{ updated: number }> {
    return this.inbox.markAllRead();
  }

  @Post(':id/read')
  @HttpCode(200)
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  read(@Param('id', ParseUUIDPipe) id: string): Promise<{ ok: true }> {
    return this.inbox.markRead(id);
  }
}
