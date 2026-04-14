export interface CardTokenOutcome {
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Well-known test card tokens that produce deterministic bank responses.
 * Use these in tests instead of relying on MOCK_FAILURE_RATE.
 *
 * tok_success              → always SETTLED
 * tok_insufficient_funds   → always FAILED  (INSUFFICIENT_FUNDS)
 * tok_card_declined        → always FAILED  (CARD_DECLINED)
 * tok_do_not_honor         → always FAILED  (DO_NOT_HONOR)
 */
export const CARD_TOKENS: Record<string, CardTokenOutcome> = {
  tok_success: {
    success: true,
  },
  tok_insufficient_funds: {
    success: false,
    errorCode: 'INSUFFICIENT_FUNDS',
    errorMessage: 'The card issuer declined due to insufficient funds.',
  },
  tok_card_declined: {
    success: false,
    errorCode: 'CARD_DECLINED',
    errorMessage: 'The card was declined by the issuer.',
  },
  tok_do_not_honor: {
    success: false,
    errorCode: 'DO_NOT_HONOR',
    errorMessage: 'The issuer returned a do-not-honor response.',
  },
};
