import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Headers,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  /**
   * Create a new payment.
   * Idempotency-Key header is required to prevent duplicate charges.
   * If a request with the same key is received, the original response is returned.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Body() dto: CreatePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string,
    @Headers('x-merchant-id') merchantId: string,
  ) {
    // Allow header-based idempotency key as override
    if (idempotencyKey) dto.idempotencyKey = idempotencyKey;
    if (merchantId) dto.merchantId = merchantId;

    return this.paymentsService.create(dto);
  }

  /**
   * Retrieve a payment with its full event history and webhook delivery log.
   */
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentsService.findOne(id);
  }

  /**
   * Refund a SETTLED payment.
   * Transitions: SETTLED → REFUNDED
   */
  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  async refund(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RefundPaymentDto,
  ) {
    return this.paymentsService.refund(id, dto);
  }

  /**
   * Manually retry a FAILED payment.
   * Transitions: FAILED → PENDING → (PROCESSING → SETTLED | FAILED)
   */
  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentsService.retry(id);
  }
}
