import { INestApplication } from '@nestjs/common';
import { Queue } from 'bullmq';

import { closeTestApp, createTestApp, waitForStatus } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('State machine — FAILED → PENDING (retry)', () => {
  let app: INestApplication;
  let queue: Queue;

  beforeAll(async () => {
    ({ app, queue } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('retries a failed transaction', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_insufficient_funds' });
    await waitForStatus(app, id, 'FAILED');

    const res = await api(app).post(`/payments/${id}/retry`);

    expect(res.status).toBe(202);
    expect(res.body.transactionId).toBe(id);

    const tx = await api(app).get(`/payments/${id}`);
    expect(tx.body.status).toBe('PENDING');
  });

  it('rejects retry of a non-FAILED transaction', async () => {
    await queue.pause();
    const { body: { id } } = await createPayment(app);

    const res = await api(app).post(`/payments/${id}/retry`);

    await queue.resume();
    expect(res.status).toBe(422);
    expect(res.body.message).toContain('PENDING');
  });
});