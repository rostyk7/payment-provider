import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { WebhookDeliveryStatus } from '@prisma/client';
import axios from 'axios';
import { Job } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { WEBHOOK_QUEUE } from './webhooks.service';

export interface WebhookJobData {
  transactionId: string;
  event: string;
  payload: Record<string, unknown>;
}

@Processor(WEBHOOK_QUEUE)
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<WebhookJobData>): Promise<void> {
    const { transactionId, event, payload } = job.data;
    const webhookUrl = payload.webhookUrl as string;
    const attempt = job.attemptsMade + 1;

    if (!webhookUrl) {
      this.logger.warn(`No webhookUrl for transaction ${transactionId}, skipping delivery`);
      return;
    }

    // Create or find the delivery record
    let delivery = await this.prisma.webhookDelivery.findFirst({
      where: { transactionId, event },
    });

    if (!delivery) {
      delivery = await this.prisma.webhookDelivery.create({
        data: {
          transactionId,
          event,
          payload: payload as object,
          status: WebhookDeliveryStatus.PENDING,
          attempt,
        },
      });
    }

    try {
      this.logger.debug(`Delivering webhook ${event} to ${webhookUrl} (attempt ${attempt})`);

      await axios.post(
        webhookUrl,
        {
          id: delivery.id,
          event,
          createdAt: new Date().toISOString(),
          data: payload,
        },
        {
          timeout: 10_000,
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': event,
            'X-Transaction-Id': transactionId,
          },
        },
      );

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: WebhookDeliveryStatus.DELIVERED,
          deliveredAt: new Date(),
          attempt,
          lastError: null,
        },
      });

      this.logger.log(`Webhook ${event} delivered to ${webhookUrl}`);
    } catch (error: any) {
      const errorMessage = error?.response
        ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}`
        : error?.message ?? 'Unknown error';

      const isFinalAttempt = attempt >= (job.opts.attempts ?? 1);

      await this.prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempt,
          lastError: errorMessage,
          status: isFinalAttempt ? WebhookDeliveryStatus.FAILED : WebhookDeliveryStatus.PENDING,
          nextRetryAt: isFinalAttempt ? null : new Date(Date.now() + 3000 * Math.pow(2, attempt)),
        },
      });

      this.logger.warn(`Webhook delivery failed (attempt ${attempt}): ${errorMessage}`);
      throw error;
    }
  }
}
