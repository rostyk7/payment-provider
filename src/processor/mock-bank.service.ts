import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BankResponse {
  success: boolean;
  referenceId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Simulates an external bank / card network.
 * MOCK_FAILURE_RATE env var (0-1) controls how often it fails.
 * MOCK_PROCESSING_DELAY_MS controls simulated latency.
 */
@Injectable()
export class MockBankService {
  private readonly logger = new Logger(MockBankService.name);
  private readonly failureRate: number;
  private readonly processingDelayMs: number;

  constructor(private readonly config: ConfigService) {
    this.failureRate = parseFloat(config.get('MOCK_FAILURE_RATE', '0.2'));
    this.processingDelayMs = parseInt(config.get('MOCK_PROCESSING_DELAY_MS', '500'));
  }

  async charge(transactionId: string, amount: number, currency: string): Promise<BankResponse> {
    this.logger.debug(`MockBank: charging ${amount} ${currency} for txn ${transactionId}`);

    await this.sleep(this.processingDelayMs);

    if (Math.random() < this.failureRate) {
      return {
        success: false,
        errorCode: 'INSUFFICIENT_FUNDS',
        errorMessage: 'The card issuer declined this transaction.',
      };
    }

    return {
      success: true,
      referenceId: `BANK-REF-${Date.now()}`,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
