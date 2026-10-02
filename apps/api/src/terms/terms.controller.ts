import { Body, Controller, Get, Put } from '@nestjs/common';
import { PublishTermsRequest, type CurrentTerms, type TermsVersion, type TermsVersionSummary } from '@pt/contracts';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { TermsService } from './terms.service';

@Controller('terms')
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  /** Mọi người trong phòng đọc được — hội viên đọc trong app. */
  @Get()
  @Roles('MEMBER', 'OWNER', 'ADMIN', 'RECEPTION', 'PT')
  current(): Promise<CurrentTerms> {
    return this.terms.current();
  }

  @Get('versions')
  @Roles('OWNER', 'ADMIN')
  versions(): Promise<TermsVersionSummary[]> {
    return this.terms.versions();
  }

  /** Chỉ CHỦ PHÒNG: điều khoản là cam kết của phòng tập với khách. */
  @Put()
  @Roles('OWNER')
  publish(@Body(new ZodPipe(PublishTermsRequest)) dto: PublishTermsRequest): Promise<TermsVersion> {
    return this.terms.publish(dto);
  }
}
