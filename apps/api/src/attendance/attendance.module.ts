import { Module } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { BookingService } from './booking.service';
import { CheckinService } from './checkin.service';
import { SessionConsumptionService } from './session-consumption.service';

@Module({
  controllers: [AttendanceController],
  providers: [BookingService, CheckinService, SessionConsumptionService],
})
export class AttendanceModule {}
