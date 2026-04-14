import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';

import { IdempotencyInterceptor } from '../../src/idempotency/idempotency.interceptor';
import { AppModule } from '../../src/app.module';
import { PAYMENT_QUEUE } from '../../src/payments/payments.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { api } from './request';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  queue: Queue;
}

export async function createTestApp(): Promise<TestApp> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  const prisma = app.get(PrismaService);
  app.useGlobalInterceptors(new IdempotencyInterceptor(prisma));

  await app.init();
  const queue = app.get<Queue>(getQueueToken(PAYMENT_QUEUE));
  return { app, prisma, queue };
}

export async function closeTestApp(app: INestApplication): Promise<void> {
  try {
    const queue = app.get<Queue>(getQueueToken(PAYMENT_QUEUE));
    await queue.obliterate({ force: true });
  } catch {
    // queue may already be closed
  }
  await app.close();
}

/**
 * Poll GET /payments/:id until the transaction reaches the expected status
 * or the timeout expires.
 */
export async function waitForStatus(
  app: INestApplication,
  id: string,
  status: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(app).get(`/payments/${id}`);
    if (res.body.status === status) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const res = await api(app).get(`/payments/${id}`);
  throw new Error(
    `Transaction ${id} did not reach ${status} within ${timeoutMs}ms — current: ${res.body.status}`,
  );
}
