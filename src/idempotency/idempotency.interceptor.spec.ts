import { BadRequestException } from '@nestjs/common';
import { of } from 'rxjs';

import { IdempotencyInterceptor } from './idempotency.interceptor';

const mockPrisma = {
  idempotencyKey: {
    findUnique: jest.fn(),
    create: jest.fn(),
    upsert: jest.fn(),
  },
};

const makeContext = (overrides: { method?: string; path?: string; key?: string; merchantId?: string } = {}) => {
  const req = {
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/payments',
    headers: {
      'idempotency-key': overrides.key ?? 'test-key',
      'x-merchant-id': overrides.merchantId ?? 'merchant_test',
    },
    body: {},
  };
  const res = { statusCode: 202, status: jest.fn() };

  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
};

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    jest.clearAllMocks();
    interceptor = new IdempotencyInterceptor(mockPrisma as any);
  });

  // ─── Non-POST routes ─────────────────────────────────────────────────────────

  it('passes through GET requests without checking idempotency key', async () => {
    const context = makeContext({ method: 'GET', path: '/payments/some-id', key: undefined });
    const next = { handle: jest.fn().mockReturnValue(of({ id: 'txn' })) };

    await interceptor.intercept(context, next as any);

    expect(next.handle).toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it('passes through POST requests to other paths', async () => {
    const context = makeContext({ path: '/payments/txn-id/refund', key: undefined });
    const next = { handle: jest.fn().mockReturnValue(of({})) };

    await interceptor.intercept(context, next as any);

    expect(next.handle).toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  // ─── Missing key ─────────────────────────────────────────────────────────────

  it('throws BadRequestException when Idempotency-Key header is missing', async () => {
    const context = makeContext({ key: undefined });
    // Override to return undefined for the key
    context.switchToHttp().getRequest().headers['idempotency-key'] = undefined;
    const next = { handle: jest.fn() };

    await expect(interceptor.intercept(context, next as any)).rejects.toThrow(BadRequestException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  // ─── Cache hit ───────────────────────────────────────────────────────────────

  it('returns cached response when idempotency key already exists', async () => {
    const cached = {
      key: 'merchant_test:test-key',
      merchantId: 'merchant_test',
      responseBody: { id: 'txn-existing', status: 'PENDING' },
      statusCode: 202,
    };
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(cached);

    const context = makeContext();
    const next = { handle: jest.fn() };

    const observable = await interceptor.intercept(context, next as any);

    let emitted: any;
    observable.subscribe((val) => (emitted = val));

    expect(emitted).toEqual(cached.responseBody);
    expect(next.handle).not.toHaveBeenCalled();
  });

  // ─── Cache miss ──────────────────────────────────────────────────────────────

  it('calls handler and caches response on cache miss', async () => {
    mockPrisma.idempotencyKey.findUnique.mockResolvedValue(null);
    mockPrisma.idempotencyKey.upsert.mockResolvedValue({});

    const responseBody = { id: 'txn-new', status: 'PENDING' };
    const context = makeContext();
    const next = { handle: jest.fn().mockReturnValue(of(responseBody)) };

    const observable = await interceptor.intercept(context, next as any);

    await new Promise<void>((resolve) => {
      observable.subscribe({ complete: resolve });
    });

    expect(next.handle).toHaveBeenCalled();
    expect(mockPrisma.idempotencyKey.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          key: 'merchant_test:test-key',
          merchantId: 'merchant_test',
          responseBody,
        }),
      }),
    );
  });
});
