import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { InvoicePdfService } from './invoice-pdf.service';

@Module({ controllers: [BillingController], providers: [BillingService, InvoicePdfService] })
export class BillingModule {}
