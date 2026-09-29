import { Module } from '@nestjs/common';
import { ReportController } from './report.controller';
import { ReportService } from './report.service';
import { PayrollService } from './payroll.service';

@Module({ controllers: [ReportController], providers: [ReportService, PayrollService] })
export class ReportModule {}
