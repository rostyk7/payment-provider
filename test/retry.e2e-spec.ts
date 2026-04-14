import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../src/prisma/prisma.service';
import { closeTestApp, createTestApp } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('State machine — FAILED → PENDING (retry)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let queue: Queue;

  beforeAll(async () => {
    ({ app, prisma, queue } = await createTestApp());
    await queue.pause();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('retries a failed transaction', async () => {
    const { body: { id } } = await createPayment(app);
    await prisma.transaction.update({ where: { id }, data: { status: 'FAILED' } });

    const res = await api(app).post(`/payments/${id}/retry`);

    expect(res.status).toBe(202);
    expect(res.body.transactionId).toBe(id);

    const tx = await prisma.transaction.findUnique({ where: { id } });
    expect(tx?.status).toBe('PENDING');
  });

  it('rejects retry of a non-FAILED transaction', async () => {
    const { body: { id } } = await createPayment(app);

    const res = await api(app).post(`/payments/${id}/retry`);

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('PENDING');
  });
});
