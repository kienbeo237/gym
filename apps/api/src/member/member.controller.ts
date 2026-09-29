import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  CreateMemberRequest,
  ListMemberQuery,
  type MemberSummary,
  type Paged,
} from '@pt/contracts';
import { MemberService } from './member.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('members')
export class MemberController {
  constructor(private readonly members: MemberService) {}

  // Lễ tân cũng xem được danh sách; PT xem được nhưng RLS + bộ lọc quyết định
  // thấy bao nhiêu. Gác vai trò ở đây chỉ là lớp THÔ.
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  list(@Query(new ZodPipe(ListMemberQuery)) q: ListMemberQuery): Promise<Paged<MemberSummary>> {
    return this.members.list(q);
  }

  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  create(@Body(new ZodPipe(CreateMemberRequest)) dto: CreateMemberRequest) {
    return this.members.create(dto);
  }
}
