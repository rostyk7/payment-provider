import { INestApplication } from '@nestjs/common';

import { closeTestApp, createTestApp } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('POST /payments', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('creates a payment in PENDING status', async () => {
    const res = await createPayment(app);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.amount).toBe(5000);
    expect(res.body.currency).toBe('USD');
    expect(res.body.id).toBeDefined();
  });

  it('returns 400 when Idempotency-Key header is missing', async () => {
    const res = await api(app)
      .post('/payments')
      .set('X-Merchant-Id', 'merchant_test')
      .send({
        amount: 5000,
        currency: 'USD',
        merchantId: 'merchant_test',
        idempotencyKey: 'some-key',
        webhookUrl: 'http://localhost:9999/webhook',
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Idempotency-Key header is required');
  });

  it('returns 400 for invalid amount (zero)', async () => {
    const res = await createPayment(app, { amount: 0 });
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid currency (not 3 chars)', async () => {
    const res = await createPayment(app, { currency: 'DOLLAR' });
    expect(res.status).toBe(400);
  });
});

describe('GET /payments/:id', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('returns the transaction with events and webhook deliveries', async () => {
    const created = await createPayment(app);
    const id = created.body.id;

    const res = await api(app).get(`/payments/${id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.events).toBeInstanceOf(Array);
    expect(res.body.webhookDeliveries).toBeInstanceOf(Array);
    expect(res.body.events[0].toStatus).toBe('PENDING');
  });

  it('returns 400 for invalid UUID', async () => {
    const res = await api(app).get('/payments/not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown transaction', async () => {
    const res = await api(app).get('/payments/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });
});
