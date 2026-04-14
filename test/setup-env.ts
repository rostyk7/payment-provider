process.env.MOCK_FAILURE_RATE = '0';
process.env.MOCK_PROCESSING_DELAY_MS = '0';
// Single attempt per job so token-driven failure tests settle immediately
process.env.PAYMENT_JOB_ATTEMPTS = '1';
