import type { AppEnvironment } from '../lib/environment';
import { createReconcileHandler, defaultDeps } from './payment-reconcile';

// PhonePe cutover Stage 2B: playx-dev-payment-reconcile-production — the 5-minute PRODUCTION
// fallback reconciler (EventBridge rate(5 minutes)). Defense in depth behind the PRODUCTION fast
// SQS chain (payment-reconcile-production-fast.ts): it catches attempts whose chain lost a message,
// hit a worker problem, or were still unresolved when the fast cadence stopped at the order's
// expiry.
//
// Same shared implementation as the SANDBOX reconciler (payment-reconcile.ts ->
// reconcilePendingPayments -> reconcilePayment -> applyProviderOutcome), with PRODUCTION
// hard-coded here: it selects only payment_environment = 'PRODUCTION' rows, and refuses to run
// unless its PhonePe secret (playx/phonepe/production, the only one its IAM role can read) itself
// declares PRODUCTION. Neither the event payload nor any environment variable can change that.

export const RECONCILER_ENVIRONMENT: AppEnvironment = 'PRODUCTION';

export const handler = createReconcileHandler(RECONCILER_ENVIRONMENT, defaultDeps);
