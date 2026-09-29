import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { BookingService } from './booking.service';
import { CheckinService } from './checkin.service';
import { SessionConsumptionService } from './session-consumption.service';

@Module({
  controllers: [AttendanceController],
  providers: [BookingService, CheckinService, SessionConsumptionService],
  // MeModule dùng lại CheckinService: mọi ràng buộc tiền bạc nằm ở đó, viết
  // lại đường điểm danh thứ hai cho app hội viên là viết lại chỗ dễ sai nhất.
  exports: [CheckinService],
})
export class AttendanceModule {}
