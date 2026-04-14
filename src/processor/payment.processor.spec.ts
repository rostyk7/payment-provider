import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { MockBankService } from './mock-bank.service';
import { PaymentJobData, PaymentProcessor } from './payment.processor';

const makeJob = (data: PaymentJobData, attemptsMade = 0, totalAttempts = 3): Partial<Job<PaymentJobData>> => ({
  data,
  attemptsMade,
  opts: { attempts: totalAttempts },
  id: 'job-1',
});

const mockTransaction = (status: TransactionStatus) => ({
  id: 'txn-uuid',
  amount: 5000,
  currency: 'USD',
  status,
  cardToken: 'tok_success',
});

const mockPrisma = {
  transaction: { findUnique: jest.fn(), update: jest.fn() },
  transactionEvent: { create: jest.fn() },
  $transaction: jest.fn(),
};

const mockBank = { charge: jest.fn() };
const mockWebhooks = { enqueue: jest.fn() };

describe('PaymentProcessor', () => {
  let processor: PaymentProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();

    mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
    mockPrisma.transaction.update.mockResolvedValue({});
    mockPrisma.transactionEvent.create.mockResolvedValue({});
    mockWebhooks.enqueue.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentProcessor,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MockBankService, useValue: mockBank },
        { provide: WebhooksService, useValue: mockWebhooks },
      ],
    })
      .setLogger({ log: () => {}, error: () => {}, warn: () => {}, debug: () => {}, verbose: () => {}, fatal: () => {} })
      .compile();

    processor = module.get(PaymentProcessor);
  });

  // ─── Terminal state guard ────────────────────────────────────────────────────

  describe('terminal state guard', () => {
    it('skips processing when transaction is already SETTLED', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction(TransactionStatus.SETTLED));

      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }) as Job<PaymentJobData>);

      expect(mockBank.charge).not.toHaveBeenCalled();
    });

    it('skips processing when transaction is already REFUNDED', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction(TransactionStatus.REFUNDED));

      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }) as Job<PaymentJobData>);

      expect(mockBank.charge).not.toHaveBeenCalled();
    });

    it('drops job silently when transaction is not found', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(
        processor.process(makeJob({ transactionId: 'missing', webhookUrl: '' }) as Job<PaymentJobData>),
      ).resolves.toBeUndefined();

      expect(mockBank.charge).not.toHaveBeenCalled();
    });
  });

  // ─── Happy path: PENDING → SETTLED ──────────────────────────────────────────

  describe('successful payment', () => {
    beforeEach(() => {
      mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction(TransactionStatus.PENDING));
      mockBank.charge.mockResolvedValue({ success: true, referenceId: 'BANK-REF-123' });
    });

    it('transitions PENDING → PROCESSING → SETTLED', async () => {
      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: 'http://example.com' }) as Job<PaymentJobData>);

      const updateCalls = mockPrisma.transaction.update.mock.calls;
      expect(updateCalls[0][0].data.status).toBe(TransactionStatus.PROCESSING);
      expect(updateCalls[1][0].data.status).toBe(TransactionStatus.SETTLED);
    });

    it('charges the bank with correct amount and currency', async () => {
      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }) as Job<PaymentJobData>);

      expect(mockBank.charge).toHaveBeenCalledWith('txn-uuid', 5000, 'USD', 'tok_success');
    });

    it('enqueues payment.processing and payment.settled webhooks', async () => {
      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: 'http://example.com' }) as Job<PaymentJobData>);

      const events = mockWebhooks.enqueue.mock.calls.map((c) => c[1]);
      expect(events).toContain('payment.processing');
      expect(events).toContain('payment.settled');
    });
  });

  // ─── Failure path ────────────────────────────────────────────────────────────

  describe('failed payment', () => {
    beforeEach(() => {
      mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction(TransactionStatus.PENDING));
      mockBank.charge.mockResolvedValue({
        success: false,
        errorCode: 'INSUFFICIENT_FUNDS',
        errorMessage: 'Card declined',
      });
    });

    it('transitions PROCESSING → FAILED on final attempt', async () => {
      const job = makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }, 2, 3); // attemptsMade=2 → attempt 3 of 3

      await expect(
        processor.process(job as Job<PaymentJobData>),
      ).resolves.toBeUndefined();

      const updateCalls = mockPrisma.transaction.update.mock.calls;
      const finalStatus = updateCalls[updateCalls.length - 1][0].data.status;
      expect(finalStatus).toBe(TransactionStatus.FAILED);
    });

    it('enqueues payment.failed webhook on final attempt', async () => {
      const job = makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }, 2, 3);

      await processor.process(job as Job<PaymentJobData>);

      const events = mockWebhooks.enqueue.mock.calls.map((c) => c[1]);
      expect(events).toContain('payment.failed');
    });

    it('resets to PENDING and throws on non-final attempt (so BullMQ retries)', async () => {
      const job = makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }, 0, 3); // attempt 1 of 3

      await expect(
        processor.process(job as Job<PaymentJobData>),
      ).rejects.toThrow('Bank declined');

      const updateCalls = mockPrisma.transaction.update.mock.calls;
      const resetStatus = updateCalls[updateCalls.length - 1][0].data.status;
      expect(resetStatus).toBe(TransactionStatus.PENDING);
    });
  });

  // ─── Event log ───────────────────────────────────────────────────────────────

  describe('event log', () => {
    it('records fromStatus and toStatus for every transition', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction(TransactionStatus.PENDING));
      mockBank.charge.mockResolvedValue({ success: true, referenceId: 'BANK-REF-1' });

      await processor.process(makeJob({ transactionId: 'txn-uuid', webhookUrl: '' }) as Job<PaymentJobData>);

      const eventCalls = mockPrisma.transactionEvent.create.mock.calls;
      const transitions = eventCalls.map((c) => ({
        from: c[0].data.fromStatus,
        to: c[0].data.toStatus,
      }));

      expect(transitions).toEqual(
        expect.arrayContaining([
          { from: TransactionStatus.PENDING, to: TransactionStatus.PROCESSING },
          { from: TransactionStatus.PROCESSING, to: TransactionStatus.SETTLED },
        ]),
      );
    });
  });
});