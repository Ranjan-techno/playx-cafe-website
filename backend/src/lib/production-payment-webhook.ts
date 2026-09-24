// PhonePe cutover Stage 2C: what an AUTHENTICATED PRODUCTION PhonePe callback does to our data.
//
// The callback is only a TRIGGER. Its payload (state, amount, transaction id) is never applied:
// given the merchantOrderId the callback authenticated (lib/phonepe-callback.ts), this looks up our
// own payment row, and — only for an open PRODUCTION PhonePe attempt — asks PhonePe's PRODUCTION
// order-status API what really happened, through the SAME
//   reconcilePayment() -> applyProviderOutcome() -> confirmSuccessfulPayment()
// path the status endpoint, the fast SQS chain and the 5-minute reconcilers use. There is no
// webhook-specific state machine: a callback saying COMPLETED while the status API says PENDING
// leaves the attempt pending.
//
// IDEMPOTENCY (PhonePe retries callbacks):
//   unknown merchantOrderId           -> 'unknown_order', no provider call
//   not a PRODUCTION row              -> 'environment_mismatch', no provider call (never asks the
//                                        production API about a SANDBOX order, never touches it)
//   already paid/failed/expired/refunded -> 'already_final', no provider call, no reversal
//   open (created/pending)            -> authoritative status via reconcilePayment(); a SUCCESS
//                                        confirms exactly once — confirmSuccessfulPayment() locks the
//                                        payment row and a concurrent/duplicate callback that got
//                                        past the terminal check sees alreadyConfirmed.
// A payment-domain refusal (e.g. amount mismatch) is 'refused': acknowledged, since a retry would
// be refused identically; the row stays as it is for the reconcilers and support. Provider,
// configuration and database failures THROW, so the handler answers 5xx and PhonePe retries.

import type { DbClient } from './allocate-simulators';
import { storedEnvironmentMatches, type AppEnvironment } from './environment';
import { PaymentDomainError, PaymentProviderError, PaymentProviderOrderNotFoundError } from './payment-errors';
import type { PaymentProviderAdapter } from './payment-provider';
import { findPaymentByProviderOrderId } from './payment-repository';
import { reconcilePayment } from './reconcile-payment';

/** The only environment this webhook ever acts on — a code constant, never configuration. */
export const WEBHOOK_ENVIRONMENT: AppEnvironment = 'PRODUCTION';

export type ProductionWebhookResult =
  | 'unknown_order'
  | 'environment_mismatch'
  | 'already_final'
  | 'confirmed'
  | 'paid_refund_required'
  | 'failed'
  | 'expired'
  | 'pending'
  | 'refused';

export interface ProductionWebhookOutcome {
  result: ProductionWebhookResult;
  paymentId?: string;
  /** For 'confirmed'/'paid_refund_required': this callback found the payment already paid. */
  alreadyConfirmed?: boolean;
  /** For 'refused': the domain error code (never a message). */
  refusal?: string;
}

const OPEN_STATUSES = new Set(['created', 'pending']);

export interface ProductionWebhookDeps {
  db: DbClient;
  /** Loaded only once an open PRODUCTION attempt is known to need a status check. */
  getProvider: () => Promise<PaymentProviderAdapter & { environment: AppEnvironment }>;
}

/** Provider/credential trouble is retryable infrastructure, not a domain refusal. */
function isRetryable(err: unknown): boolean {
  return (
    err instanceof PaymentProviderError ||
    err instanceof PaymentProviderOrderNotFoundError ||
    (err instanceof Error && err.name === 'PhonePeConfigError')
  );
}

export async function processProductionPaymentCallback(
  deps: ProductionWebhookDeps,
  merchantOrderId: string,
): Promise<ProductionWebhookOutcome> {
  const { db } = deps;
  const payment = await findPaymentByProviderOrderId(db, 'phonepe', merchantOrderId);
  if (!payment) {
    return { result: 'unknown_order' };
  }
  const paymentId = payment.id;
  if (!storedEnvironmentMatches(payment.payment_environment, WEBHOOK_ENVIRONMENT)) {
    return { result: 'environment_mismatch', paymentId };
  }
  if (!OPEN_STATUSES.has(payment.payment_status)) {
    return { result: 'already_final', paymentId };
  }

  const provider = await deps.getProvider();
  if (provider.environment !== WEBHOOK_ENVIRONMENT) {
    throw new Error(`Webhook provider is configured for ${String(provider.environment)}, not ${WEBHOOK_ENVIRONMENT}`);
  }

  try {
    const { applied } = await reconcilePayment(db, provider, payment.provider_order_id);
    switch (applied.status) {
      case 'confirmed':
        return { result: 'confirmed', paymentId, alreadyConfirmed: applied.alreadyConfirmed };
      case 'paid_refund_required':
        return { result: 'paid_refund_required', paymentId, alreadyConfirmed: applied.alreadyConfirmed };
      case 'failed':
        return { result: 'failed', paymentId };
      case 'expired':
        return { result: 'expired', paymentId };
      case 'pending':
        return { result: 'pending', paymentId };
    }
  } catch (err) {
    if (err instanceof PaymentDomainError && !isRetryable(err)) {
      return { result: 'refused', paymentId, refusal: err.code };
    }
    throw err;
  }
}
