import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { TransactionStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PAYMENT_QUEUE } from '../payments/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { MockBankService } from './mock-bank.service';

export interface PaymentJobData {
  transactionId: string;
  webhookUrl: string;
}

@Processor(PAYMENT_QUEUE)
export class PaymentProcessor extends WorkerHost {
  private readonly logger = new Logger(PaymentProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bank: MockBankService,
    private readonly webhooks: WebhooksService,
  ) {
    super();
  }

  async process(job: Job<PaymentJobData>): Promise<void> {
    const { transactionId, webhookUrl } = job.data;
    const attempt = job.attemptsMade + 1;

    this.logger.log(`Processing payment ${transactionId} (attempt ${attempt})`);

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      this.logger.error(`Transaction ${transactionId} not found — dropping job`);
      return;
    }

    // Guard: skip if already in a terminal state (idempotent worker)
    if (
      transaction.status === TransactionStatus.SETTLED ||
      transaction.status === TransactionStatus.REFUNDED
    ) {
      this.logger.warn(`Transaction ${transactionId} already in terminal state ${transaction.status}`);
      return;
    }

    // Transition: PENDING → PROCESSING
    await this.transition(transactionId, transaction.status, TransactionStatus.PROCESSING, {
      reason: `Processing attempt ${attempt}`,
      attempt,
    });

    await this.webhooks.enqueue(transactionId, 'payment.processing', {
      transactionId,
      status: TransactionStatus.PROCESSING,
      webhookUrl,
    });

    // Call the mock bank
    const bankResponse = await this.bank.charge(
      transactionId,
      transaction.amount,
      transaction.currency,
    );

    if (bankResponse.success) {
      // PROCESSING → SETTLED
      await this.transition(transactionId, TransactionStatus.PROCESSING, TransactionStatus.SETTLED, {
        reason: `Settled via bank ref ${bankResponse.referenceId}`,
        attempt,
      });

      await this.webhooks.enqueue(transactionId, 'payment.settled', {
        transactionId,
        status: TransactionStatus.SETTLED,
        referenceId: bankResponse.referenceId,
        webhookUrl,
      });

      this.logger.log(`Transaction ${transactionId} SETTLED`);
    } else {
      // On final attempt: PROCESSING → FAILED
      // On non-final attempt: BullMQ will retry — reset to PENDING so the guard above doesn't skip
      const isFinalAttempt = attempt >= (job.opts.attempts ?? 1);

      if (isFinalAttempt) {
        await this.transition(transactionId, TransactionStatus.PROCESSING, TransactionStatus.FAILED, {
          reason: `Bank declined: ${bankResponse.errorCode} — ${bankResponse.errorMessage}`,
          attempt,
        });

        await this.webhooks.enqueue(transactionId, 'payment.failed', {
          transactionId,
          status: TransactionStatus.FAILED,
          errorCode: bankResponse.errorCode,
          webhookUrl,
        });

        this.logger.warn(`Transaction ${transactionId} FAILED after ${attempt} attempts`);
      } else {
        // Reset to PENDING so next attempt re-enters the state machine cleanly
        await this.transition(transactionId, TransactionStatus.PROCESSING, TransactionStatus.PENDING, {
          reason: `Bank declined on attempt ${attempt}, will retry`,
          attempt,
        });

        this.logger.warn(`Transaction ${transactionId} will retry (attempt ${attempt})`);
        throw new Error(`Bank declined: ${bankResponse.errorCode}`);
      }
    }
  }

  private async transition(
    transactionId: string,
    fromStatus: TransactionStatus | null,
    toStatus: TransactionStatus,
    meta: { reason: string; attempt: number },
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: toStatus },
      });

      await tx.transactionEvent.create({
        data: {
          transactionId,
          fromStatus,
          toStatus,
          reason: meta.reason,
          attempt: meta.attempt,
        },
      });
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PaymentJobData>, error: Error) {
    this.logger.error(
      `Job ${job.id} for transaction ${job.data.transactionId} failed: ${error.message}`,
    );
  }
}
