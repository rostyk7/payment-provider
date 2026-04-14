import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CARD_TOKENS } from './card-tokens';

export interface BankResponse {
  success: boolean;
  referenceId?: string;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Simulates an external bank / card network.
 *
 * If a recognised card token is supplied the response is deterministic —
 * useful for stable e2e tests.  Unknown or absent tokens fall back to
 * MOCK_FAILURE_RATE-based random behaviour.
 *
 * MOCK_FAILURE_RATE env var (0-1) controls the random failure rate.
 * MOCK_PROCESSING_DELAY_MS controls simulated latency.
 */
@Injectable()
export class MockBankService {
  private readonly logger = new Logger(MockBankService.name);
  private readonly failureRate: number;
  private readonly processingDelayMs: number;

  constructor(config: ConfigService) {
    this.failureRate = parseFloat(config.get('MOCK_FAILURE_RATE', '0.2'));
    this.processingDelayMs = parseInt(config.get('MOCK_PROCESSING_DELAY_MS', '500'));
  }

  async charge(
    transactionId: string,
    amount: number,
    currency: string,
    cardToken?: string,
  ): Promise<BankResponse> {
    this.logger.debug(
      `MockBank: charging ${amount} ${currency} for txn ${transactionId}` +
        (cardToken ? ` (token: ${cardToken})` : ''),
    );

    await this.sleep(this.processingDelayMs);

    // Deterministic path: known card token overrides random behaviour
    if (cardToken && CARD_TOKENS[cardToken]) {
      const outcome = CARD_TOKENS[cardToken];
      if (outcome.success) {
        return { success: true, referenceId: `BANK-REF-${Date.now()}` };
      }
      return {
        success: false,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
      };
    }

    // Random path: used when no token is provided
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
