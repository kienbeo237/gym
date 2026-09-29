import { Global, Module } from '@nestjs/common';
import { CommissionService } from './commission.service';

// Global: phase 3 (điểm danh) cũng cần nó để ghi hoa hồng TEACH.
@Global()
@Module({ providers: [CommissionService], exports: [CommissionService] })
export class CommissionModule {}
