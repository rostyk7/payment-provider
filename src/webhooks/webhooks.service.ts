import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const WEBHOOK_QUEUE = 'webhook-delivery';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
  ) {}

  async enqueue(transactionId: string, event: string, payload: Record<string, unknown>) {
    await this.webhookQueue.add(
      'deliver-webhook',
      { transactionId, event, payload },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 3000 },
      },
    );

    this.logger.debug(`Enqueued webhook ${event} for transaction ${transactionId}`);
  }
}
