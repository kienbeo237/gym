import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { MeService } from './me.service';
import { AttendanceModule } from '../attendance/attendance.module';

@Module({ imports: [AttendanceModule], controllers: [MeController], providers: [MeService] })
export class MeModule {}
