import { INestApplication } from '@nestjs/common';

import { PrismaService } from '../src/prisma/prisma.service';
import { closeTestApp, createTestApp } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('Event log', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('records immutable event log for every transition', async () => {
    const { body: { id } } = await createPayment(app);

    await prisma.transaction.update({ where: { id }, data: { status: 'SETTLED' } });
    await prisma.transactionEvent.create({
      data: { transactionId: id, fromStatus: 'PENDING', toStatus: 'SETTLED', reason: 'test' },
    });
    await api(app).post(`/payments/${id}/refund`).send({});

    const res = await api(app).get(`/payments/${id}`);
    const statuses = res.body.events.map((e: any) => e.toStatus);

    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('SETTLED');
    expect(statuses).toContain('REFUNDED');
  });
});
