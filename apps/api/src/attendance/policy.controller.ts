import { Body, Controller, Get, Put } from '@nestjs/common';
import { UpdateBookingPolicy, type BookingPolicy } from '@pt/contracts';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { BookingPolicyService } from './policy.service';

@Controller('settings')
export class BookingPolicyController {
  constructor(private readonly svc: BookingPolicyService) {}

  @Get('booking-policy')
  @Roles('OWNER', 'ADMIN')
  get(): Promise<BookingPolicy> {
    return this.svc.get();
  }

  /** Chỉ CHỦ PHÒNG: huỷ muộn / vắng mặt có trừ buổi hay không là chuyện tiền của khách. */
  @Put('booking-policy')
  @Roles('OWNER')
  update(@Body(new ZodPipe(UpdateBookingPolicy)) dto: UpdateBookingPolicy): Promise<BookingPolicy> {
    return this.svc.update(dto);
  }
}
