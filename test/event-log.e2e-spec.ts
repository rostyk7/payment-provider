import { INestApplication } from '@nestjs/common';

import { closeTestApp, createTestApp, waitForStatus } from './helpers/app';
import { api, createPayment } from './helpers/request';

describe('Event log', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('records immutable event log for every transition', async () => {
    const { body: { id } } = await createPayment(app, { cardToken: 'tok_success' });
    await waitForStatus(app, id, 'SETTLED');

    await api(app).post(`/payments/${id}/refund`).send({ reason: 'Test refund' });

    const res = await api(app).get(`/payments/${id}`);
    const statuses = res.body.events.map((e: any) => e.toStatus);

    expect(statuses).toContain('PENDING');
    expect(statuses).toContain('SETTLED');
    expect(statuses).toContain('REFUNDED');
  });
});
