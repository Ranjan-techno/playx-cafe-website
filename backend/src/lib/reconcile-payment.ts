// Provider-agnostic payment reconciliation: ask the provider what happened to an order, then
// route that normalized outcome through the same applyProviderOutcome() -> confirmSuccessfulPayment()
// path a webhook will use. Reusable from a status-poll endpoint, a payment-return page, or a
// scheduled sweep.
//
// The provider HTTP call happens BEFORE any DB work and outside any transaction; the DB write is
// then a single self-contained transaction (confirmSuccessfulPayment) or a single-statement update.

import type { DbClient } from './allocate-simulators';
import type { PaymentProviderAdapter } from './payment-provider';
import { applyProviderOutcome, type ApplyProviderOutcomeResult } from './sync-payment-status';

export interface ReconcileResult {
  providerOutcome: 'SUCCESS' | 'FAILED' | 'PENDING';
  applied: ApplyProviderOutcomeResult;
  /** The order expiry the provider reported on this status call, if any (normalized by the
   *  adapter). Informational — never used to decide an outcome. */
  providerExpiresAt?: Date;
}

export async function reconcilePayment(
  db: DbClient,
  provider: PaymentProviderAdapter,
  providerOrderId: string,
): Promise<ReconcileResult> {
  const status = await provider.getPaymentStatus(providerOrderId);
  const applied = await applyProviderOutcome(db, {
    provider: provider.provider,
    providerOrderId,
    outcome: status.outcome,
    providerTransactionId: status.providerTransactionId,
    amountInr: status.amountInr,
    currency: status.currency,
    failureReason: status.failureReason,
  });
  return { providerOutcome: status.outcome, applied, ...(status.providerExpiresAt ? { providerExpiresAt: status.providerExpiresAt } : {}) };
}
