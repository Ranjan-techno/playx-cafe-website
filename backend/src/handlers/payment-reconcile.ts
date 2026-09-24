import type { Context } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import type { AppEnvironment } from '../lib/environment';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import { getPhonePePaymentProvider } from '../lib/phonepe-runtime';
import {
  DEFAULT_BATCH_SIZE,
  reconcilePendingPayments,
  type ReconcileRunSummary,
} from '../lib/reconcile-pending-payments';

// Phase 5A: scheduled (EventBridge, every 5 minutes) background reconciliation of open PhonePe
// payment attempts. Not an HTTP route — there is no API surface and no caller identity. See
// lib/reconcile-pending-payments.ts for selection/batching and why repeated runs are safe.
//
// This is the SANDBOX reconciler: it passes SANDBOX explicitly, so it only ever selects SANDBOX (and
// transitional NULL) attempts, and refuses to run if its PhonePe secret is not a SANDBOX one.
//
// Logs only ids, statuses and error class names. Never provider payloads, checkout URLs, tokens or
// credentials.

export interface PaymentReconcileDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getProvider: () => Promise<PaymentProviderAdapter & { environment: AppEnvironment }>;
  env: Record<string, string | undefined>;
}

/** The environment this scheduled Lambda reconciles — a backend constant, never configuration
 *  a caller can influence. */
export const RECONCILER_ENVIRONMENT: AppEnvironment = 'SANDBOX';

const defaultDeps: PaymentReconcileDeps = {
  getDb,
  resetDb,
  getProvider: () => getPhonePePaymentProvider(),
  env: process.env,
};

/** Stop starting new items when this little time remains (one provider call + DB work). */
const SAFETY_MARGIN_MS = 30_000;

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function createHandler(deps: PaymentReconcileDeps = defaultDeps) {
  return async (_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<ReconcileRunSummary> => {
    try {
      const db = await deps.getDb();
      const provider = await deps.getProvider();
      const summary = await reconcilePendingPayments(db, provider, RECONCILER_ENVIRONMENT, {
        batchSize: boundedInt(deps.env.RECONCILE_BATCH_SIZE, DEFAULT_BATCH_SIZE, 1, 100),
        hasTimeLeft: context ? () => context.getRemainingTimeInMillis() > SAFETY_MARGIN_MS : undefined,
      });
      if (summary.hadUnexpectedError) {
        deps.resetDb();
      }
      console.log('payment-reconcile run', JSON.stringify(summary));
      return summary;
    } catch (err) {
      // Whole-run failure (DB unreachable, credentials unavailable). The next scheduled run retries.
      deps.resetDb();
      console.error('payment-reconcile failed', err instanceof Error ? err.name : 'unknown');
      throw err;
    }
  };
}

export const handler = createHandler();
