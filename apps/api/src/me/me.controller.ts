import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  MyCheckinRequest,
  MyLedgerQuery,
  SaveProgressRequest,
  type CheckinResponse,
  type MyInvoice,
  type MyLedgerEntry,
  type MySummary,
  type ProgressEntry,
} from '@pt/contracts';
import { MeService } from './me.service';
import { CheckinService } from '../attendance/checkin.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

/**
 * App của HỘI VIÊN.
 *
 * KHÔNG endpoint nào ở đây nhận `memberId` — danh tính lấy từ token. Nhân viên
 * cũng gọi được (họ có thể vừa là hội viên), và khi đó cũng chỉ thấy hồ sơ của
 * chính họ; muốn xem người khác thì dùng các màn quản lý.
 */
@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    private readonly checkin: CheckinService,
  ) {}

  @Get('summary')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  summary(): Promise<MySummary> {
    return this.me.summary();
  }

  @Get('ledger')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  ledger(@Query(new ZodPipe(MyLedgerQuery)) q: MyLedgerQuery): Promise<MyLedgerEntry[]> {
    return this.me.ledger(q);
  }

  @Get('invoices')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  invoices(): Promise<MyInvoice[]> {
    return this.me.invoices();
  }

  @Get('trainers')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  trainers() {
    return this.me.myTrainers();
  }

  @Get('progress')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  progress(): Promise<ProgressEntry[]> {
    return this.me.progress();
  }

  @Post('progress')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  saveProgress(@Body(new ZodPipe(SaveProgressRequest)) dto: SaveProgressRequest) {
    return this.me.saveProgress(dto);
  }

  /**
   * Điểm danh bằng mã QR quét từ màn hình huấn luyện viên.
   *
   * Dùng lại CheckinService — mọi ràng buộc tiền bạc (khoá hợp đồng, sổ cái,
   * doanh thu, hoa hồng) nằm ở đó. Viết lại ở đây là viết lại chỗ dễ sai nhất.
   * `MEMBER_CONFIRM` buộc CheckinService kiểm `ctx.memberId === booking.member_id`.
   */
  @Post('checkin')
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  doCheckin(@Body(new ZodPipe(MyCheckinRequest)) dto: MyCheckinRequest): Promise<CheckinResponse> {
    return this.checkin.checkIn(dto.bookingId, { token: dto.token, method: 'QR' });
  }
}
