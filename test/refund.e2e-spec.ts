import { INestApplication } from '@nestjs/common';

import { PrismaService } from '../src/prisma/prisma.service';
import { closeTestApp, createTestApp } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('State machine — SETTLED → REFUNDED', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('refunds a settled transaction', async () => {
    const { body: { id } } = await createPayment(app);
    await prisma.transaction.update({ where: { id }, data: { status: 'SETTLED' } });

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Customer request' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
  });

  it('rejects refund of a PENDING transaction', async () => {
    const { body: { id } } = await createPayment(app);

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Test' });

    expect(res.status).toBe(422);
    expect(res.body.message).toContain('PENDING');
  });

  it('rejects refund of a FAILED transaction', async () => {
    const { body: { id } } = await createPayment(app);
    await prisma.transaction.update({ where: { id }, data: { status: 'FAILED' } });

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Test' });

    expect(res.status).toBe(422);
  });
});
