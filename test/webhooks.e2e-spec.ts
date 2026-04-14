import { INestApplication } from '@nestjs/common';

import { closeTestApp, createTestApp } from './helpers/app';
import { createPayment } from './helpers/request';
import { WebhookServer } from './helpers/webhook-server';

// Payment processing + webhook delivery = two async hops; give them room
jest.setTimeout(20_000);

describe('Webhooks — delivery', () => {
  let app: INestApplication;
  let webhookServer: WebhookServer;

  beforeAll(async () => {
    // Start the listener before the app so no deliveries are missed
    webhookServer = new WebhookServer();
    await webhookServer.start();
    ({ app } = await createTestApp());
    console.log('[webhook-test] server listening on :9999, app ready');
  });

  afterAll(async () => {
    await closeTestApp(app);
    await webhookServer.stop();
  });

  it('delivers payment.processing and payment.settled for tok_success', async () => {
    const { body: { id } } = await createPayment(app, {
      cardToken: 'tok_success',
      webhookUrl: webhookServer.url,
    });

    const processing = await webhookServer.waitForEvent('payment.processing', id);
    expect(processing.body.data.transactionId).toBe(id);
    expect(processing.body.data.status).toBe('PROCESSING');

    const settled = await webhookServer.waitForEvent('payment.settled', id);
    expect(settled.body.data.transactionId).toBe(id);
    expect(settled.body.data.status).toBe('SETTLED');
    expect(settled.body.data.referenceId).toMatch(/^BANK-REF-/);
  });

  it('delivers payment.processing and payment.failed for tok_insufficient_funds', async () => {
    const { body: { id } } = await createPayment(app, {
      cardToken: 'tok_insufficient_funds',
      webhookUrl: webhookServer.url,
    });

    const processing = await webhookServer.waitForEvent('payment.processing', id);
    expect(processing.body.data.status).toBe('PROCESSING');

    const failed = await webhookServer.waitForEvent('payment.failed', id);
    expect(failed.body.data.transactionId).toBe(id);
    expect(failed.body.data.status).toBe('FAILED');
    expect(failed.body.data.errorCode).toBe('INSUFFICIENT_FUNDS');
  });

  it('delivers payment.processing and payment.failed for tok_card_declined', async () => {
    const { body: { id } } = await createPayment(app, {
      cardToken: 'tok_card_declined',
      webhookUrl: webhookServer.url,
    });

    await webhookServer.waitForEvent('payment.processing', id);

    const failed = await webhookServer.waitForEvent('payment.failed', id);
    expect(failed.body.data.errorCode).toBe('CARD_DECLINED');
  });

  it('delivers payment.processing and payment.failed for tok_do_not_honor', async () => {
    const { body: { id } } = await createPayment(app, {
      cardToken: 'tok_do_not_honor',
      webhookUrl: webhookServer.url,
    });

    await webhookServer.waitForEvent('payment.processing', id);

    const failed = await webhookServer.waitForEvent('payment.failed', id);
    expect(failed.body.data.errorCode).toBe('DO_NOT_HONOR');
  });

  it('webhook payload has the correct shape and headers', async () => {
    const { body: { id } } = await createPayment(app, {
      cardToken: 'tok_success',
      webhookUrl: webhookServer.url,
    });

    const settled = await webhookServer.waitForEvent('payment.settled', id);

    expect(settled.body).toMatchObject({
      id: expect.any(String),
      event: 'payment.settled',
      createdAt: expect.any(String),
      data: expect.objectContaining({
        transactionId: id,
        status: 'SETTLED',
      }),
    });
    expect(settled.headers['x-webhook-event']).toBe('payment.settled');
    expect(settled.headers['x-transaction-id']).toBe(id);
  });
});
