import { INestApplication } from '@nestjs/common';

import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './helpers/app';
import { createPayment } from './helpers/request';

describe('Idempotency', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns the same transaction for duplicate idempotency key', async () => {
    const key = `idem-${Date.now()}`;

    const first = await createPayment(app, {}, key);
    const second = await createPayment(app, {}, key);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(first.body.id).toBe(second.body.id);
  });

  it('does not create a second transaction for duplicate key', async () => {
    const key = `idem-count-${Date.now()}`;

    const first = await createPayment(app, {}, key);
    await createPayment(app, {}, key);
    await createPayment(app, {}, key);

    const count = await prisma.transaction.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
    expect(first.body.id).toBeDefined();
  });
});
