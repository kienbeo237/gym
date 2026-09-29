import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ListInvoiceQuery,
  RecordPaymentRequest,
  RefundRequest,
  type InvoiceDetail,
  type InvoiceSummary,
  type Paged,
  type PaymentResult,
} from '@pt/contracts';
import { BillingService } from './billing.service';
import { Roles } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';

@Controller('invoices')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Get()
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  list(@Query(new ZodPipe(ListInvoiceQuery)) q: ListInvoiceQuery): Promise<Paged<InvoiceSummary>> {
    return this.billing.list(q);
  }

  @Get(':id')
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<InvoiceDetail> {
    return this.billing.detail(id);
  }

  // Lễ tân thu tiền — đó là việc của quầy. PT thì không: người bán tự xác nhận
  // đã thu tiền của chính hợp đồng mình ăn hoa hồng là bỏ mất chốt kiểm soát.
  @Post(':id/payments')
  @Roles('OWNER', 'ADMIN', 'RECEPTION')
  pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RecordPaymentRequest)) dto: RecordPaymentRequest,
  ): Promise<PaymentResult> {
    return this.billing.recordPayment(id, dto);
  }

  // Hoàn tiền và huỷ hoá đơn là quyết định của chủ phòng, không phải của quầy.
  @Post(':id/refunds')
  @Roles('OWNER', 'ADMIN')
  refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(RefundRequest)) dto: RefundRequest,
  ): Promise<PaymentResult> {
    return this.billing.refund(id, dto);
  }

  @Post(':id/void')
  @Roles('OWNER', 'ADMIN')
  void(@Param('id', ParseUUIDPipe) id: string, @Body() body: { reason?: string }) {
    return this.billing.voidInvoice(id, body?.reason ?? 'Không ghi lý do');
  }
}
