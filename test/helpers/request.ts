import { INestApplication } from '@nestjs/common';

import request from 'supertest';

export const api = (app: INestApplication) => request(app.getHttpServer());

export const createPayment = (
  app: INestApplication,
  overrides: Record<string, unknown> = {},
  key = `key-${Date.now()}-${Math.random()}`,
) =>
  api(app)
    .post('/payments')
    .set('Idempotency-Key', key)
    .set('X-Merchant-Id', 'merchant_test')
    .send({
      amount: 5000,
      currency: 'USD',
      merchantId: 'merchant_test',
      idempotencyKey: key,
      webhookUrl: 'http://localhost:9999/webhook',
      cardToken: 'tok_success',
      ...overrides,
    });
