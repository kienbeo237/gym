import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  UploadUrlRequest,
  type DownloadUrlResponse,
  type UploadUrlResponse,
} from '@pt/contracts';
import { StorageService } from './storage.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('files')
export class StorageController {
  constructor(private readonly storage: StorageService) {}

  // Hội viên tự tải ảnh tiến độ của mình lên, nên MEMBER cũng xin được URL.
  // Phạm vi ai xem được cái gì do RLS + ownerId quyết định, không do vai trò.
  @Post('upload-url')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  createUploadUrl(@Body(new ZodPipe(UploadUrlRequest)) dto: UploadUrlRequest): Promise<UploadUrlResponse> {
    return this.storage.createUploadUrl(dto);
  }

  @Post(':id/confirm')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  confirm(@Param('id', ParseUUIDPipe) id: string) {
    return this.storage.confirmUpload(id);
  }

  @Get(':id/url')
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT', 'MEMBER')
  download(@Param('id', ParseUUIDPipe) id: string): Promise<DownloadUrlResponse> {
    return this.storage.createDownloadUrl(id);
  }
}
