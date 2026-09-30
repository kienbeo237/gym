import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { BookingService } from './booking.service';
import { CheckinService } from './checkin.service';
import { SessionConsumptionService } from './session-consumption.service';
import { BookingPolicyController } from './policy.controller';
import { BookingPolicyService } from './policy.service';

@Module({
  controllers: [AttendanceController, BookingPolicyController],
  providers: [BookingService, CheckinService, SessionConsumptionService, BookingPolicyService],
  // MeModule dùng lại CheckinService: mọi ràng buộc tiền bạc nằm ở đó, viết
  // lại đường điểm danh thứ hai cho app hội viên là viết lại chỗ dễ sai nhất.
  // Worker dùng BookingService cho lượt quét đóng buổi / tự đánh vắng.
  exports: [CheckinService, BookingService],
})
export class AttendanceModule {}
