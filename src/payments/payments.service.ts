import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TransactionStatus } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { RefundPaymentDto } from './dto/refund-payment.dto';

export const PAYMENT_QUEUE = 'payment-processing';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(PAYMENT_QUEUE) private readonly paymentQueue: Queue,
  ) {}

  async create(dto: CreatePaymentDto) {
    const existing = await this.prisma.transaction.findUnique({
      where: { idempotencyKey: dto.idempotencyKey },
    });

    if (existing) {
      return existing;
    }

    const transaction = await this.prisma.$transaction(async (tx) => {
      const created = await tx.transaction.create({
        data: {
          merchantId: dto.merchantId,
          amount: dto.amount,
          currency: dto.currency,
          idempotencyKey: dto.idempotencyKey,
          cardToken: dto.cardToken,
          metadata: (dto.metadata ?? {}) as object,
          status: TransactionStatus.PENDING,
        },
      });

      await tx.transactionEvent.create({
        data: {
          transactionId: created.id,
          fromStatus: null,
          toStatus: TransactionStatus.PENDING,
          reason: 'Payment created',
        },
      });

      return created;
    });

    const attempts = parseInt(this.config.get('PAYMENT_JOB_ATTEMPTS', '3'), 10);

    await this.paymentQueue.add(
      'process-payment',
      {
        transactionId: transaction.id,
        webhookUrl: dto.webhookUrl,
      },
      {
        attempts,
        backoff: { type: 'exponential', delay: 2000 },
        jobId: transaction.id,
      },
    );

    return transaction;
  }

  async findOne(id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        webhookDeliveries: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    return transaction;
  }

  async refund(id: string, dto: RefundPaymentDto) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    if (transaction.status !== TransactionStatus.SETTLED) {
      throw new UnprocessableEntityException(
        `Cannot refund transaction in status ${transaction.status}. Only SETTLED transactions can be refunded.`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.transaction.update({
        where: { id },
        data: { status: TransactionStatus.REFUNDED },
      });

      await tx.transactionEvent.create({
        data: {
          transactionId: id,
          fromStatus: TransactionStatus.SETTLED,
          toStatus: TransactionStatus.REFUNDED,
          reason: dto.reason ?? 'Refund requested',
        },
      });

      return result;
    });

    return updated;
  }

  async retry(id: string) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${id} not found`);
    }

    if (transaction.status !== TransactionStatus.FAILED) {
      throw new UnprocessableEntityException(
        `Cannot retry transaction in status ${transaction.status}. Only FAILED transactions can be retried.`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id },
        data: { status: TransactionStatus.PENDING },
      });

      await tx.transactionEvent.create({
        data: {
          transactionId: id,
          fromStatus: TransactionStatus.FAILED,
          toStatus: TransactionStatus.PENDING,
          reason: 'Manual retry requested',
        },
      });
    });

    const webhookDelivery = await this.prisma.webhookDelivery.findFirst({
      where: { transactionId: id },
      orderBy: { createdAt: 'desc' },
    });

    await this.paymentQueue.add(
      'process-payment',
      {
        transactionId: id,
        webhookUrl: webhookDelivery?.payload
          ? (webhookDelivery.payload as any).webhookUrl
          : '',
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    return { message: 'Transaction queued for retry', transactionId: id };
  }
}
