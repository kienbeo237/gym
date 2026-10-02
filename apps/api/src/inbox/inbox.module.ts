import { Module } from '@nestjs/common';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { StaffReminderService } from './staff-reminder.service';

/** Worker nạp module này để lấy StaffReminderService; controller chỉ phục vụ ở tiến trình API. */
@Module({ controllers: [InboxController], providers: [InboxService, StaffReminderService], exports: [StaffReminderService] })
export class InboxModule {}
