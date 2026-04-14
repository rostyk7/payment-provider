import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PaymentProcessor } from './payment.processor';
import { MockBankService } from './mock-bank.service';
import { PAYMENT_QUEUE } from '../payments/payments.service';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: PAYMENT_QUEUE }),
    WebhooksModule,
  ],
  providers: [PaymentProcessor, MockBankService],
})
export class ProcessorModule {}
