import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  CreatePackageRequest,
  ListPackageQuery,
  UpdatePackageRequest,
  type Paged,
  type PackageSummary,
} from '@pt/contracts';
import { PackageService } from './package.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('packages')
export class PackageController {
  constructor(private readonly packages: PackageService) {}

  // Hội viên cũng xem được bảng giá — đó là danh mục bán hàng, không phải bí mật.
  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  list(@Query(new ZodPipe(ListPackageQuery)) q: ListPackageQuery): Promise<Paged<PackageSummary>> {
    return this.packages.list(q);
  }

  @Post()
  @Roles('OWNER', 'ADMIN')
  create(@Body(new ZodPipe(CreatePackageRequest)) dto: CreatePackageRequest) {
    return this.packages.create(dto);
  }

  @Patch(':id')
  @Roles('OWNER', 'ADMIN')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UpdatePackageRequest)) dto: UpdatePackageRequest,
  ) {
    return this.packages.update(id, dto);
  }

  @Delete(':id')
  @Roles('OWNER', 'ADMIN')
  archive(@Param('id', ParseUUIDPipe) id: string) {
    return this.packages.archive(id);
  }
}
