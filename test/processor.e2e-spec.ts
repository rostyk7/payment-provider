import { INestApplication } from '@nestjs/common';

import { closeTestApp, createTestApp, waitForStatus } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('Processor — card token outcomes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('settles a payment when tok_success is used', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_success' });

    await waitForStatus(app, id, 'SETTLED');

    const res = await api(app).get(`/payments/${id}`);
    expect(res.body.status).toBe('SETTLED');
    const statuses = res.body.events.map((e: any) => e.toStatus);
    expect(statuses).toEqual(expect.arrayContaining(['PENDING', 'PROCESSING', 'SETTLED']));
  });

  it('fails a payment when tok_insufficient_funds is used', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_insufficient_funds' });

    await waitForStatus(app, id, 'FAILED');

    const res = await api(app).get(`/payments/${id}`);
    expect(res.body.status).toBe('FAILED');
    const failedEvent = res.body.events.find((e: any) => e.toStatus === 'FAILED');
    expect(failedEvent.reason).toContain('INSUFFICIENT_FUNDS');
  });

  it('fails a payment when tok_card_declined is used', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_card_declined' });

    await waitForStatus(app, id, 'FAILED');

    const res = await api(app).get(`/payments/${id}`);
    expect(res.body.status).toBe('FAILED');
    const failedEvent = res.body.events.find((e: any) => e.toStatus === 'FAILED');
    expect(failedEvent.reason).toContain('CARD_DECLINED');
  });

  it('fails a payment when tok_do_not_honor is used', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_do_not_honor' });

    await waitForStatus(app, id, 'FAILED');

    const res = await api(app).get(`/payments/${id}`);
    expect(res.body.status).toBe('FAILED');
    const failedEvent = res.body.events.find((e: any) => e.toStatus === 'FAILED');
    expect(failedEvent.reason).toContain('DO_NOT_HONOR');
  });
});