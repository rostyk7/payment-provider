import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TransactionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { PAYMENT_QUEUE, PaymentsService } from './payments.service';

const mockTransaction = (overrides = {}) => ({
  id: 'txn-uuid',
  merchantId: 'merchant_test',
  amount: 5000,
  currency: 'USD',
  status: TransactionStatus.PENDING,
  idempotencyKey: 'key-001',
  metadata: {},
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const mockPrisma = {
  transaction: {
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  transactionEvent: {
    create: jest.fn(),
  },
  webhookDelivery: {
    findFirst: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockQueue = {
  add: jest.fn(),
};

describe('PaymentsService', () => {
  let service: PaymentsService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: getQueueToken(PAYMENT_QUEUE), useValue: mockQueue },
      ],
    }).compile();

    service = module.get(PaymentsService);
  });

  // ─── create ─────────────────────────────────────────────────────────────────

  describe('create', () => {
    const dto = {
      amount: 5000,
      currency: 'USD',
      merchantId: 'merchant_test',
      idempotencyKey: 'key-001',
      webhookUrl: 'http://example.com/webhook',
    };

    it('returns existing transaction when idempotency key already exists', async () => {
      const existing = mockTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(existing);

      const result = await service.create(dto);

      expect(result).toBe(existing);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockQueue.add).not.toHaveBeenCalled();
    });

    it('creates a new transaction and enqueues a job when key is new', async () => {
      const created = mockTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
      mockPrisma.transaction.create.mockResolvedValue(created);
      mockPrisma.transactionEvent.create.mockResolvedValue({});
      mockQueue.add.mockResolvedValue({});

      const result = await service.create(dto);

      expect(result).toBe(created);
      expect(mockPrisma.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: TransactionStatus.PENDING,
            idempotencyKey: dto.idempotencyKey,
          }),
        }),
      );
      expect(mockQueue.add).toHaveBeenCalledWith(
        'process-payment',
        expect.objectContaining({ transactionId: created.id }),
        expect.objectContaining({ attempts: 3 }),
      );
    });

    it('records a PENDING event on creation', async () => {
      const created = mockTransaction();
      mockPrisma.transaction.findUnique.mockResolvedValue(null);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
      mockPrisma.transaction.create.mockResolvedValue(created);
      mockPrisma.transactionEvent.create.mockResolvedValue({});
      mockQueue.add.mockResolvedValue({});

      await service.create(dto);

      expect(mockPrisma.transactionEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toStatus: TransactionStatus.PENDING,
            fromStatus: null,
          }),
        }),
      );
    });
  });

  // ─── findOne ────────────────────────────────────────────────────────────────

  describe('findOne', () => {
    it('returns the transaction with events and webhookDeliveries', async () => {
      const tx = { ...mockTransaction(), events: [], webhookDeliveries: [] };
      mockPrisma.transaction.findUnique.mockResolvedValue(tx);

      const result = await service.findOne('txn-uuid');

      expect(result).toBe(tx);
      expect(mockPrisma.transaction.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'txn-uuid' } }),
      );
    });

    it('throws NotFoundException when transaction does not exist', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ─── refund ─────────────────────────────────────────────────────────────────

  describe('refund', () => {
    it('transitions SETTLED → REFUNDED', async () => {
      const settled = mockTransaction({ status: TransactionStatus.SETTLED });
      const refunded = mockTransaction({ status: TransactionStatus.REFUNDED });
      mockPrisma.transaction.findUnique.mockResolvedValue(settled);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
      mockPrisma.transaction.update.mockResolvedValue(refunded);
      mockPrisma.transactionEvent.create.mockResolvedValue({});

      const result = await service.refund('txn-uuid', { reason: 'Customer request' });

      expect(result.status).toBe(TransactionStatus.REFUNDED);
      expect(mockPrisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: TransactionStatus.REFUNDED },
        }),
      );
    });

    it('throws NotFoundException for unknown transaction', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.refund('missing', {})).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when transaction is not SETTLED', async () => {
      for (const status of [TransactionStatus.PENDING, TransactionStatus.PROCESSING, TransactionStatus.FAILED]) {
        mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction({ status }));

        await expect(service.refund('txn-uuid', {})).rejects.toThrow(UnprocessableEntityException);
      }
    });
  });

  // ─── retry ──────────────────────────────────────────────────────────────────

  describe('retry', () => {
    it('transitions FAILED → PENDING and re-enqueues', async () => {
      const failed = mockTransaction({ status: TransactionStatus.FAILED });
      mockPrisma.transaction.findUnique.mockResolvedValue(failed);
      mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockPrisma));
      mockPrisma.transaction.update.mockResolvedValue({});
      mockPrisma.transactionEvent.create.mockResolvedValue({});
      mockPrisma.webhookDelivery.findFirst.mockResolvedValue(null);
      mockQueue.add.mockResolvedValue({});

      const result = await service.retry('txn-uuid');

      expect(result.transactionId).toBe('txn-uuid');
      expect(mockPrisma.transaction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { status: TransactionStatus.PENDING },
        }),
      );
      expect(mockQueue.add).toHaveBeenCalled();
    });

    it('throws NotFoundException for unknown transaction', async () => {
      mockPrisma.transaction.findUnique.mockResolvedValue(null);

      await expect(service.retry('missing')).rejects.toThrow(NotFoundException);
    });

    it('throws UnprocessableEntityException when transaction is not FAILED', async () => {
      for (const status of [TransactionStatus.PENDING, TransactionStatus.PROCESSING, TransactionStatus.SETTLED]) {
        mockPrisma.transaction.findUnique.mockResolvedValue(mockTransaction({ status }));

        await expect(service.retry('txn-uuid')).rejects.toThrow(UnprocessableEntityException);
      }
    });
  });
});
