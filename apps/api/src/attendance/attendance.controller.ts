import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  AvailableSlotsQuery,
  CancelBookingRequest,
  CheckinRequest,
  CreateBookingRequest,
  ListBookingQuery,
  MarkNoShowRequest,
  RescheduleBookingRequest,
  type AvailableSlots,
  type BookingItem,
  type CancelBookingResponse,
  type CheckinResponse,
  type CheckinTokenResponse,
  type RescheduleBookingResponse,
} from '@pt/contracts';
import { BookingService } from './booking.service';
import { CheckinService } from './checkin.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('bookings')
export class AttendanceController {
  constructor(
    private readonly bookings: BookingService,
    private readonly checkin: CheckinService,
  ) {}

  // Hội viên xem được lịch — RLS lo phạm vi phòng tập, còn "chỉ lịch của tôi"
  // thì họ tự truyền memberId. Đây là dữ liệu trong cùng một phòng nên không
  // phải bí mật giữa các hội viên.
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  list(@Query(new ZodPipe(ListBookingQuery)) q: ListBookingQuery): Promise<BookingItem[]> {
    return this.bookings.list(q);
  }

  /** Khung giờ trống của người dạy một hợp đồng. Hội viên chỉ hỏi được hợp đồng của mình. */
  @Get('slots')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  slots(@Query(new ZodPipe(AvailableSlotsQuery)) q: AvailableSlotsQuery): Promise<AvailableSlots> {
    return this.bookings.slots(q);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<BookingItem> {
    return this.bookings.get(id);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  create(@Body(new ZodPipe(CreateBookingRequest)) dto: CreateBookingRequest) {
    return this.bookings.create(dto);
  }

  @Post(':id/cancel')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CancelBookingRequest)) dto: CancelBookingRequest,
  ): Promise<CancelBookingResponse> {
    return this.bookings.cancel(id, dto);
  }

  /** Đổi giờ buổi đang chờ — giữ nguyên buổi, không trừ buổi. */
  @Post(':id/reschedule')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RescheduleBookingRequest)) dto: RescheduleBookingRequest,
  ): Promise<RescheduleBookingResponse> {
    return this.bookings.reschedule(id, dto);
  }

  // Đánh dấu vắng mặt là thao tác TRỪ BUỔI của khách — không để hội viên tự làm.
  @Post(':id/no-show')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  noShow(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(MarkNoShowRequest)) dto: MarkNoShowRequest,
  ): Promise<CancelBookingResponse> {
    return this.bookings.markNoShow(id, dto.note);
  }

  /** Huấn luyện viên mở buổi -> mã QR sống 60 giây. */
  @Post(':id/checkin-token')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  token(@Param('id', ParseUUIDPipe) id: string): Promise<CheckinTokenResponse> {
    return this.checkin.issueToken(id);
  }

  @Post(':id/checkin')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  doCheckin(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CheckinRequest)) dto: CheckinRequest,
  ): Promise<CheckinResponse> {
    return this.checkin.checkIn(id, dto);
  }
}
