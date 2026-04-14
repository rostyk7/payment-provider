import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';

import { closeTestApp, createTestApp, waitForStatus } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('State machine — SETTLED → REFUNDED', () => {
  let app: INestApplication;
  let queue: Queue;

  beforeAll(async () => {
    ({ app, queue } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('refunds a settled transaction', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_success' });
    await waitForStatus(app, id, 'SETTLED');

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Customer request' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('REFUNDED');
  });

  it('rejects refund of a PENDING transaction', async () => {
    await queue.pause();
    const { body: { id } } = await createPayment(app);

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Test' });

    await queue.resume();
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('PENDING');
  });

  it('rejects refund of a FAILED transaction', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_insufficient_funds' });
    await waitForStatus(app, id, 'FAILED');

    const res = await api(app).post(`/payments/${id}/refund`).send({ reason: 'Test' });

    expect(res.status).toBe(422);
  });
});
