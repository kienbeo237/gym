import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreateTrainerRequest,
  ListTrainerQuery,
  SetAvailabilityRequest,
  UpdateTrainerRequest,
  type Paged,
  type TrainerDetail,
  type TrainerSummary,
} from '@pt/contracts';
import { TrainerService } from './trainer.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('trainers')
export class TrainerController {
  constructor(private readonly trainers: TrainerService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  list(@Query(new ZodPipe(ListTrainerQuery)) q: ListTrainerQuery): Promise<Paged<TrainerSummary>> {
    return this.trainers.list(q);
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
