import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreateTrainerRequest,
  ListTrainerQuery,
  SetAvailabilityRequest,
  UpdateTrainerRequest,
  type Paged,
  type TrainerDetail,
  type TrainerOption,
  type TrainerSummary,
} from '@pt/contracts';
import { TrainerService } from './trainer.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('trainers')
export class TrainerController {
  constructor(private readonly trainers: TrainerService) {}

  // Có SĐT, doanh thu, hoa hồng từng người — HLV không xem được của đồng
  // nghiệp. Ô chọn HLV dùng /trainers/options.
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  list(@Query(new ZodPipe(ListTrainerQuery)) q: ListTrainerQuery): Promise<Paged<TrainerSummary>> {
    return this.trainers.list(q);
  }

  // Khai TRƯỚC ':id' — không thì 'options' bị coi là một id.
  @Get('options')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  options(): Promise<TrainerOption[]> {
    return this.trainers.options();
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<TrainerDetail> {
    return this.trainers.detail(id);
  }

  // Thêm PT là việc của chủ phòng: nó tiêu hạn mức gói dịch vụ và kèm chính
  // sách hoa hồng. Lễ tân không được.
  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Body(new ZodPipe(CreateTrainerRequest)) dto: CreateTrainerRequest) {
    return this.trainers.create(dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdateTrainerRequest)) dto: UpdateTrainerRequest,
  ) {
    return this.trainers.update(id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.trainers.deactivate(id);
  }

  @Get(':id/availability')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  getAvailability(@Param('id', ParseUUIDPipe) id: string) {
    return this.trainers.getAvailability(id);
  }

  @Post(':id/availability')
  @Roles('OWNER', 'ADMIN', 'PT')
  setAvailability(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SetAvailabilityRequest)) dto: SetAvailabilityRequest,
  ) {
    return this.trainers.setAvailability(id, dto);
  }
}
