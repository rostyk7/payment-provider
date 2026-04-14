import * as http from 'http';
import { AddressInfo } from 'net';

export interface ReceivedWebhook {
  event: string;
  transactionId: string;
  body: {
    id: string;
    event: string;
    createdAt: string;
    data: Record<string, unknown>;
  };
  headers: Record<string, string | string[] | undefined>;
}

interface PendingWaiter {
  match: (w: ReceivedWebhook) => boolean;
  resolve: (w: ReceivedWebhook) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Lightweight HTTP server that captures incoming webhook POST requests.
 *
 * Uses port 0 so the OS picks a free port — call start() first, then read
 * .url to get the address to pass to createPayment().
 */
export class WebhookServer {
  private readonly server: http.Server;
  private received: ReceivedWebhook[] = [];
  private waiters: PendingWaiter[] = [];
  private _url = '';

  /** Available after start() resolves. */
  get url(): string {
    return this._url;
  }

  constructor() {
    this.server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        try {
          const body = JSON.parse(raw);
          const webhook: ReceivedWebhook = {
            event: body.event,
            transactionId: req.headers['x-transaction-id'] as string,
            body,
            headers: req.headers,
          };

          this.received.push(webhook);

          this.waiters = this.waiters.filter((w) => {
            if (w.match(webhook)) {
              clearTimeout(w.timer);
              w.resolve(webhook);
              return false;
            }
            return true;
          });
        } catch {
          // ignore malformed payloads
        }
        res.writeHead(200).end('ok');
      });
    });
  }

  /** Binds to a free port on 127.0.0.1 and sets this.url. */
  start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address() as AddressInfo;
        this._url = `http://127.0.0.1:${addr.port}/webhook`;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /**
   * Resolves with the first webhook matching (event, transactionId).
   * If one was already received it resolves immediately.
   */
  waitForEvent(event: string, transactionId: string, timeoutMs = 10_000): Promise<ReceivedWebhook> {
    const existing = this.received.find(
      (w) => w.event === event && w.transactionId === transactionId,
    );
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `Webhook "${event}" for transaction ${transactionId} not received within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
      this.waiters.push({
        match: (w) => w.event === event && w.transactionId === transactionId,
        resolve,
        reject,
        timer,
      });
    });
  }
}
