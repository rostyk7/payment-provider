import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';

import { IdempotencyInterceptor } from '../../src/idempotency/idempotency.interceptor';
import { AppModule } from '../../src/app.module';
import { PAYMENT_QUEUE } from '../../src/payments/payments.service';
import { PrismaService } from '../../src/prisma/prisma.service';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
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
  return { app, prisma };
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
