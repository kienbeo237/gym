import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ClosePayrollRequest,
  DashboardQuery,
  PeriodMonth,
  type DashboardResponse,
  type PackageReportRow,
  type PayrollResponse,
  type TrainerReportRow,
} from '@pt/contracts';
import { ReportService } from './report.service';
import { PayrollService } from './payroll.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('reports')
export class ReportController {
  constructor(
    private readonly reports: ReportService,
    private readonly payroll: PayrollService,
  ) {}

  // Số liệu tài chính của cả phòng tập — chỉ chủ phòng và quản lý.
  @Get('dashboard')
  @Roles('OWNER', 'ADMIN')
  dashboard(@Query(new ZodPipe(DashboardQuery)) q: DashboardQuery): Promise<DashboardResponse> {
    return this.reports.dashboard(q.month);
  }

  @Get('trainers')
  @Roles('OWNER', 'ADMIN')
  trainers(@Query('month') month?: string): Promise<TrainerReportRow[]> {
    return this.reports.trainers(month ? PeriodMonth.parse(month) : undefined);
  }

  @Get('packages')
  @Roles('OWNER', 'ADMIN')
  packages(@Query('month') month?: string): Promise<PackageReportRow[]> {
    return this.reports.packages(month ? PeriodMonth.parse(month) : undefined);
  }

  @Post('refresh')
  @Roles('OWNER', 'ADMIN')
  refresh() {
    return this.reports.refresh();
  }

  // Bảng lương là dữ liệu nhân sự — hẹp hơn nữa, chỉ chủ phòng.
  @Get('payroll')
  @Roles('OWNER')
  viewPayroll(@Query('month') month: string): Promise<PayrollResponse> {
    return this.payroll.view(PeriodMonth.parse(month));
  }

  @Post('payroll/close')
  @Roles('OWNER')
  close(@Body(new ZodPipe(ClosePayrollRequest)) dto: ClosePayrollRequest): Promise<PayrollResponse> {
    return this.payroll.close(dto);
  }

  @Post('payroll/mark-paid')
  @Roles('OWNER')
  markPaid(@Body() body: { month: string }): Promise<PayrollResponse> {
    return this.payroll.markPaid(PeriodMonth.parse(body?.month));
  }
}
