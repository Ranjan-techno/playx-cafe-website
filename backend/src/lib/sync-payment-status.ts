// Phase 3A: the dispatcher between "what did the provider say?" (a PaymentProviderAdapter result
// — see payment-provider.ts) and "what should the database do about it?". This is the one place
// that decides SUCCESS -> confirmSuccessfulPayment(), FAILED -> markPaymentFailed(), PENDING ->
// leave it alone — no other module in this codebase makes that call, so a provider status of
// PENDING or FAILED can never accidentally reach confirmSuccessfulPayment() by a different path.
//
// Not wired to any handler/route/schedule in this phase (see the brief: no webhook infrastructure
// yet) — a later phase calls this from a webhook handler (passing a WebhookVerificationResult
// already verified by the provider adapter) or a status-polling job (passing a
// ProviderStatusResult from getPaymentStatus()). Both shapes are ProviderStatusResult-compatible,
// which is all this function needs.

import type { DbClient } from './allocate-simulators';
import { confirmSuccessfulPayment } from './confirm-successful-payment';
import { markPaymentExpired, markPaymentFailed, markPaymentPending, type PaymentProvider } from './payment-repository';
import type { ProviderOutcome } from './payment-provider';

export interface ApplyProviderOutcomeInput {
  provider: PaymentProvider;
  providerOrderId: string;
  outcome: ProviderOutcome;
  providerTransactionId?: string;
  amountInr?: number;
  currency?: string;
  failureReason?: string;
  /** True for a payment whose hold window is known to have lapsed (e.g. the caller is a
   *  scheduled sweep of stale 'created'/'pending' attempts, not a provider-reported outcome) —
   *  routes to 'expired' instead of 'failed' regardless of `outcome`. Defaults to false. */
  expired?: boolean;
}

export type ApplyProviderOutcomeResult =
  | { status: 'confirmed'; paymentId: string; bookingId: string; alreadyConfirmed: boolean }
  | { status: 'failed' }
  | { status: 'expired' }
  | { status: 'pending' };

/**
 * Routes one provider-reported outcome to the correct payment-state transition. SUCCESS is the
 * only outcome that can ever confirm a booking — see confirmSuccessfulPayment(), which this
 * delegates to and which independently re-validates amount/currency/idempotency regardless of
 * what this function already believes. FAILED and PENDING (and the explicit `expired` flag) never
 * call it: a booking's HOLD allocations and 'pending' status are left completely untouched for
 * PENDING (there is nothing yet to act on), and moved to a terminal payment state for FAILED/
 * expired without touching the booking or its allocations at all — a failed/expired *payment
 * attempt* does not by itself cancel a booking (see this phase's brief: "a failed/expired payment
 * attempt does not corrupt the booking"); that stays 'pending', still holding its simulator(s)
 * until either a new payment attempt succeeds or the HOLD itself lapses (see
 * allocate-simulators.ts's expired-hold handling, unchanged by this phase).
 */
export async function applyProviderOutcome(db: DbClient, input: ApplyProviderOutcomeInput): Promise<ApplyProviderOutcomeResult> {
  if (input.expired) {
    await markExpiredAttempt(db, input);
    return { status: 'expired' };
  }

  switch (input.outcome) {
    case 'SUCCESS': {
      if (input.amountInr === undefined) {
        throw new Error('applyProviderOutcome: amountInr is required when outcome is SUCCESS');
      }
      const result = await confirmSuccessfulPayment(db, {
        provider: input.provider,
        providerOrderId: input.providerOrderId,
        amountInr: input.amountInr,
        currency: input.currency,
        providerTransactionId: input.providerTransactionId,
      });
      return { status: 'confirmed', ...result };
    }
    case 'FAILED': {
      await markPaymentFailed(db, await paymentIdFor(db, input), input.failureReason ?? 'Provider reported failure');
      return { status: 'failed' };
    }
    case 'PENDING': {
      await markPaymentPending(db, await paymentIdFor(db, input));
      return { status: 'pending' };
    }
    default: {
      // Exhaustiveness guard — ProviderOutcome is a closed union, so this is unreachable at
      // compile time; kept only as a defensive runtime fallback.
      const exhaustive: never = input.outcome;
      throw new Error(`applyProviderOutcome: unknown outcome ${String(exhaustive)}`);
    }
  }
}

async function markExpiredAttempt(db: DbClient, input: ApplyProviderOutcomeInput): Promise<void> {
  await markPaymentExpired(db, await paymentIdFor(db, input));
}

/** markPaymentFailed/markPaymentExpired/markPaymentPending all key off payments.id, but the
 *  natural external key this function receives is (provider, providerOrderId) — same as
 *  confirmSuccessfulPayment(). A single unlocked lookup (no FOR UPDATE) is enough here: unlike
 *  confirmSuccessfulPayment(), these three transitions have nothing else to keep consistent in the
 *  same transaction, and each of their own UPDATEs is already filtered to a safe source
 *  payment_status (see payment-repository.ts), so a benign race just makes one of two concurrent
 *  callers' UPDATEs a no-op rather than corrupting anything. */
async function paymentIdFor(db: DbClient, input: { provider: PaymentProvider; providerOrderId: string }): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM payments WHERE provider = $1 AND provider_order_id = $2`,
    [input.provider, input.providerOrderId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`applyProviderOutcome: no payment found for provider "${input.provider}" order "${input.providerOrderId}"`);
  }
  return row.id;
}
