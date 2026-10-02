import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreateMemberRequest,
  GiftSessionsRequest,
  ListMemberQuery,
  type GiftSessionsResponse,
  UpdateMemberRequest,
  type MemberDetail,
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

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<MemberDetail> {
    return this.members.detail(id);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(UpdateMemberRequest)) dto: UpdateMemberRequest) {
    return this.members.update(id, dto);
  }

  // Tặng buổi là cho đi thứ có giá: chỉ chủ phòng / quản lý. Lễ tân và HLV đề
  // xuất qua họ — không thì quầy tự tặng cho người quen mà không ai duyệt.
  @Post(':id/packages/:packageId/gift')
  @Roles('OWNER', 'ADMIN')
  gift(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('packageId', ParseUUIDPipe) packageId: string,
    @Body(new ZodPipe(GiftSessionsRequest)) dto: GiftSessionsRequest,
  ): Promise<GiftSessionsResponse> {
    return this.members.giftSessions(id, packageId, dto);
  }
}
