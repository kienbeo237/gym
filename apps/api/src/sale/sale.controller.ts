import { Body, Controller, Post } from '@nestjs/common';
import { SellPackageRequest, type SellPackageResponse } from '@pt/contracts';
import { SaleService } from './sale.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('sales')
export class SaleController {
  constructor(private readonly sales: SaleService) {}

  // PT được bán gói của chính mình — đó là việc thường ngày ở phòng tập.
  // Hội viên thì không: bán hàng là thao tác sinh công nợ.
  @Post()
  @Roles('OWNER', 'ADMIN', 'RECEPTION', 'PT')
  sell(@Body(new ZodPipe(SellPackageRequest)) dto: SellPackageRequest): Promise<SellPackageResponse> {
    return this.sales.sell(dto);
  }
}
