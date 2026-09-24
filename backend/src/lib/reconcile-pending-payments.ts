// Phase 5A: background payment reconciliation — a bounded sweep over open PhonePe attempts so a
// customer never has to come back to payment-return.html for their payment to be recorded.
//
// This module owns ONLY selection, batching and failure isolation. Every state transition still
// goes through reconcilePayment() -> applyProviderOutcome() -> confirmSuccessfulPayment(), the same
// path the status endpoint uses, so late-payment/capacity handling, amount checks, idempotency and
// the second-success rule live in exactly one place. Repeated or overlapping runs are safe for the
// same reason: confirmSuccessfulPayment locks payment+booking and treats an already-paid attempt as
// a no-op, and terminal attempts are never selected.
//
// ENVIRONMENT: a run is for exactly one environment, passed explicitly by the caller (the existing
// scheduled Lambda passes SANDBOX). Only that environment's attempts are selected (SANDBOX also
// covers transitional NULL rows; PRODUCTION never does), and the provider must be configured for
// the same environment — otherwise the run refuses to start rather than asking one environment's
// PhonePe account about the other's orders.
//
// Output is safe to log: ids, statuses and error class names only — never provider payloads,
// checkout URLs, tokens or credentials.

import type { DbClient } from './allocate-simulators';
import { assertAppEnvironment, storedEnvironmentMatches, type AppEnvironment } from './environment';
import { PaymentDomainError } from './payment-errors';
import type { PaymentProviderAdapter } from './payment-provider';
import { listPaymentsForReconciliation, mergePaymentMetadata } from './payment-repository';
import { reconcilePayment } from './reconcile-payment';

export const DEFAULT_BATCH_SIZE = 25;

export type ReconcileItemResult =
  | 'still_pending'
  | 'confirmed'
  | 'confirmed_after_reallocation'
  | 'paid_refund_required'
  | 'duplicate_paid_refund_required'
  | 'failed'
  | 'expired'
  | 'error';

export interface ReconcileItemSummary {
  paymentId: string;
  bookingId: string;
  result: ReconcileItemResult;
  /** Error class name / domain code only — never a message (messages can echo provider data). */
  error?: string;
}

export interface ReconcileRunSummary {
  scanned: number;
  processed: number;
  /** Candidates not processed because the run ran out of time or stopped on an unexpected error. */
  deferred: number;
  counts: Partial<Record<ReconcileItemResult, number>>;
  items: ReconcileItemSummary[];
  /** True when an error was not an expected domain/provider error (e.g. a DB failure). The batch
   *  stops at that point (no more provider calls on a possibly-bad connection) and the caller
   *  should drop its cached DB connection. */
  hadUnexpectedError: boolean;
}

export interface ReconcileRunOptions {
  batchSize?: number;
  /** Return false to stop starting new items (e.g. Lambda about to time out). */
  hasTimeLeft?: () => boolean;
}

export async function reconcilePendingPayments(
  db: DbClient,
  provider: PaymentProviderAdapter & { environment: AppEnvironment },
  environment: AppEnvironment,
  options: ReconcileRunOptions = {},
): Promise<ReconcileRunSummary> {
  assertAppEnvironment(environment, 'environment');
  if (provider.environment !== environment) {
    throw new Error(`Payment provider is configured for ${String(provider.environment)}, not ${environment}`);
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  // The SQL already filters by environment; re-checking each row keeps the invariant local.
  const candidates = (await listPaymentsForReconciliation(db, environment, batchSize)).filter((c) =>
    storedEnvironmentMatches(c.payment_environment, environment),
  );

  const summary: ReconcileRunSummary = {
    scanned: candidates.length,
    processed: 0,
    deferred: 0,
    counts: {},
    items: [],
    hadUnexpectedError: false,
  };

  for (const candidate of candidates) {
    if (options.hasTimeLeft && !options.hasTimeLeft()) {
      summary.deferred = candidates.length - summary.processed;
      break;
    }
    summary.processed += 1;
    const item: ReconcileItemSummary = { paymentId: candidate.id, bookingId: candidate.booking_id, result: 'error' };
    try {
      const { applied } = await reconcilePayment(db, provider, candidate.provider_order_id);
      switch (applied.status) {
        case 'confirmed':
          item.result = applied.outcome;
          break;
        case 'paid_refund_required':
          item.result = applied.duplicateOfPaymentId ? 'duplicate_paid_refund_required' : 'paid_refund_required';
          break;
        case 'failed':
          item.result = 'failed';
          break;
        case 'expired':
          item.result = 'expired';
          break;
        case 'pending':
          item.result = 'still_pending';
          await markChecked(db, candidate.id);
          break;
      }
    } catch (err) {
      item.result = 'error';
      item.error = err instanceof PaymentDomainError ? err.code : err instanceof Error ? err.name : 'unknown';
      // Rotate even a failing attempt to the back of the queue, so a persistently failing head of
      // the queue can't starve the candidates behind it.
      await markChecked(db, candidate.id);
      if (!(err instanceof PaymentDomainError) && !isExpectedProviderTrouble(err)) {
        summary.hadUnexpectedError = true;
      }
    }
    summary.counts[item.result] = (summary.counts[item.result] ?? 0) + 1;
    summary.items.push(item);
    if (summary.hadUnexpectedError) {
      // Likely a DB/connection fault: don't keep calling the provider on a known-bad connection.
      // The rest are deferred to the next run (after the handler resets the connection).
      summary.deferred = candidates.length - summary.processed;
      break;
    }
  }
  return summary;
}

/** Stamps the attempt as just-checked (ordering key for listPaymentsForReconciliation). Best-effort:
 *  a failed bookkeeping write must never change the outcome of the attempt itself, and nothing
 *  about the failure is logged (it could echo connection details). */
async function markChecked(db: DbClient, paymentId: string): Promise<void> {
  await mergePaymentMetadata(db, paymentId, { reconcileCheckedAt: new Date().toISOString() }).catch(() => {});
}

/** PhonePeConfigError (bad/missing credentials) is not a domain error but is also not a DB fault. */
function isExpectedProviderTrouble(err: unknown): boolean {
  return err instanceof Error && err.name === 'PhonePeConfigError';
}
