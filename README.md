# Payment Provider API

A production-grade payment processing service built with NestJS, PostgreSQL, and Redis. Implements the full transaction lifecycle with async processing, idempotency, and webhook delivery — the core engine of any payments platform.

## Architecture

```
POST /payments
      │
      ▼
┌─────────────────┐
│  Idempotency    │  ← Returns cached response if duplicate key
│  Interceptor    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Payments       │  ← Creates transaction (PENDING), enqueues job
│  Service        │
└────────┬────────┘
         │
         ▼  BullMQ
┌─────────────────┐
│  Payment        │  ← PENDING → PROCESSING → SETTLED | FAILED
│  Processor      │    Retry up to 3x with exponential backoff
└────────┬────────┘
         │
         ▼  BullMQ
┌─────────────────┐
│  Webhook        │  ← Fires on every state transition
│  Processor      │    Retries up to 5x, logs all delivery attempts
└─────────────────┘
```

## State Machine

```
                    ┌──────────┐
                    │  PENDING │ ◄─── Manual retry (FAILED → PENDING)
                    └────┬─────┘
                         │ worker picks up
                         ▼
                    ┌──────────────┐
                    │  PROCESSING  │
                    └──────┬───────┘
              ┌────────────┴─────────────┐
              │ bank success             │ bank failure (all retries exhausted)
              ▼                          ▼
         ┌──────────┐              ┌──────────┐
         │ SETTLED  │              │  FAILED  │
         └────┬─────┘              └──────────┘
              │ refund requested
              ▼
         ┌──────────┐
         │ REFUNDED │
         └──────────┘
```

## Running Locally

**Prerequisites:** Docker + Docker Compose

```bash
# 1. Start infrastructure
docker-compose up postgres redis -d

# 2. Copy env
cp .env.example .env

# 3. Run migrations
npx prisma migrate dev --name init

# 4. Start the API
npm run start:dev
```

Or run everything with Docker:

```bash
npm run build
docker-compose up
```

## API Reference

### Create Payment

```bash
POST /payments
Idempotency-Key: order_123
X-Merchant-Id: merchant_abc
Content-Type: application/json

{
  "amount": 10000,
  "currency": "USD",
  "merchantId": "merchant_abc",
  "idempotencyKey": "order_123",
  "webhookUrl": "https://yourapp.com/webhooks",
  "cardToken": "tok_success",
  "metadata": { "orderId": "ord_456" }
}
```

#### Card Tokens

The `cardToken` field controls how the mock bank responds to the charge. Use well-known test tokens to get deterministic outcomes:

| Token | Outcome | Error code |
|---|---|---|
| `tok_success` | `SETTLED` | — |
| `tok_insufficient_funds` | `FAILED` | `INSUFFICIENT_FUNDS` |
| `tok_card_declined` | `FAILED` | `CARD_DECLINED` |
| `tok_do_not_honor` | `FAILED` | `DO_NOT_HONOR` |

Any unrecognised token falls back to random behaviour governed by `MOCK_FAILURE_RATE`.

Response `202 Accepted`:
```json
{
  "id": "uuid",
  "status": "PENDING",
  "amount": 10000,
  "currency": "USD",
  "createdAt": "..."
}
```

### Get Payment

```bash
GET /payments/:id
```

Returns the transaction with full event history and webhook delivery log.

### Refund Payment

```bash
POST /payments/:id/refund

{ "reason": "Customer request" }
```

Only valid for `SETTLED` transactions. Transitions to `REFUNDED`.

### Retry Failed Payment

```bash
POST /payments/:id/retry
```

Only valid for `FAILED` transactions. Re-queues for processing.

## Webhook Events

Delivered to the `webhookUrl` provided at payment creation:

| Event | Trigger |
|---|---|
| `payment.processing` | Worker picks up the transaction |
| `payment.settled` | Bank confirms successful charge |
| `payment.failed` | All retry attempts exhausted |
| `payment.refunded` | Refund processed |

Webhook payload:
```json
{
  "id": "delivery-uuid",
  "event": "payment.settled",
  "createdAt": "2024-01-01T00:00:00Z",
  "data": {
    "transactionId": "uuid",
    "status": "SETTLED",
    "referenceId": "BANK-REF-1234567890"
  }
}
```

Failed deliveries are retried up to **5 times** with exponential backoff. All attempts are logged in `webhook_deliveries`.

## Key Design Decisions

**Idempotency** — Every `POST /payments` requires an `Idempotency-Key` header. Duplicate requests within 24 hours return the original response without creating a new transaction. Prevents double-charges from network retries.

**Immutable event log** — Every state transition appends to `transaction_events`. The current `status` on the transaction is a projection; the full history is always preserved.

**Decoupled webhook delivery** — Webhooks run in a separate BullMQ queue from payment processing. A slow or failing webhook endpoint never blocks the payment processor.

**Terminal state guard** — The worker checks the current status before processing. A `SETTLED` or `REFUNDED` transaction is skipped even if somehow re-queued, preventing double-settlement.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `MOCK_FAILURE_RATE` | `0.2` | Bank failure rate (0–1) for unrecognised card tokens |
| `MOCK_PROCESSING_DELAY_MS` | `500` | Simulated bank latency in ms |
| `PAYMENT_JOB_ATTEMPTS` | `3` | Max retry attempts per payment job |

## Tech Stack

- **NestJS** — Modular Node.js framework
- **PostgreSQL + Prisma** — Typed database access, schema migrations
- **BullMQ + Redis** — Async job processing and webhook delivery
- **class-validator** — DTO validation at the boundary
