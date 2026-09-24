import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { ensureFastReconcileScheduled, FastReconcileScheduleError } from '../lib/fast-reconcile-payment';
import { errorResponse, jsonResponse } from '../lib/http';
import { PaymentProviderError } from '../lib/payment-errors';
import { isSafeCheckoutRedirect, mapPaymentError, parseBookingIdFromBody, readIdentity } from '../lib/payment-http';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import { findCustomerBooking } from '../lib/payment-repository';
import { getCheckoutHoldMinutes, getPaymentReturnUrl } from '../lib/payment-settings';
import type { PhonePeEnvironment } from '../lib/phonepe-config';
import type * as PhonePeRuntime from '../lib/phonepe-runtime';
import { assertProductionTesterAllowed } from '../lib/production-access';
import { createSqsReconcileQueue, isValidQueueUrl, type ReconcileQueue } from '../lib/reconcile-queue';
import { assertPaymentStartAllowed, type PaymentUserIdentity } from '../lib/sandbox-access';
import { startPayment } from '../lib/start-payment';

// POST /payments/start — begins a PhonePe checkout for the caller's own pending booking.
//
// Cognito-JWT-protected (infra/lib/constructs/api.ts). The body carries ONLY { bookingId }; the
// amount comes from bookings.price_inr inside startPayment(), the environment and return URL from
// the Lambda's own config, and the customer from the verified `sub` — no price, status,
// environment, redirect URL, order id or simulator id is ever read from the request.
//
// Order of checks (cheapest/most-restrictive first, no provider or DB work before the gate):
//   PAYMENT_START_ENABLED kill switch (503) -> 401 no verified sub -> 400 bad bookingId ->
//   environment tester gate (403) -> ownership (404) -> startPayment() -> re-check the gate
//   against the environment the secret ACTUALLY declares.
//
// Tester gates (both server-side, both fail closed on an empty list):
//   SANDBOX     PHONEPE_SANDBOX_TESTERS — Cognito subs and/or verified emails (sandbox-access.ts).
//   PRODUCTION  PHONEPE_PRODUCTION_TESTERS — Cognito subs ONLY (production-access.ts). PhonePe
//               cutover Stage 2C: even once PAYMENT_START_ENABLED is later turned on for the
//               production Lambda, only allowlisted subjects may start a production payment.
//
// Kill switch: payment initiation runs only when the Lambda's PAYMENT_START_ENABLED is exactly
// "true" (set explicitly per function in infra/lib/constructs/api.ts). Missing, "false", "TRUE",
// " true" or anything else is disabled — fail closed. While disabled the handler returns a generic
// 503 as its very first step: no DB connection, no Secrets Manager read, no PhonePe SDK load, no
// provider construction, no payment row and no provider call. The response names neither the
// environment nor the reason.
//
// PRODUCTION fast reconciliation (PhonePe cutover Stage 2B): every PRODUCTION checkout MUST be
// followed by PhonePe's mandatory status-check cadence, driven by the production fast-reconcile SQS
// queue (PAYMENT_RECONCILE_QUEUE_URL). So, for PRODUCTION only:
//   - a missing/invalid queue URL fails closed (503) BEFORE the DB, the secret or PhonePe — checked
//     against both the deploy config (PHONEPE_ENVIRONMENT) and, again, the environment the secret
//     actually declares, before startPayment() can create an order;
//   - after startPayment() has created (or reused) the order AND persisted it, the first chain link
//     is enqueued (22s after initiation). If that fails — or the chain can't be confirmed to exist
//     (attempt no longer open, fast window already over) — the customer gets a 503 instead of the
//     redirect; the persisted attempt is kept, and a retry reuses it (no second PhonePe order) and
//     schedules the chain then. A reused attempt whose chain already started gets a recovery copy
//     of its current link instead, so a dead-lettered chain is revived before the redirect (see
//     lib/fast-reconcile-payment.ts's ensureFastReconcileScheduled).
// SANDBOX is untouched: no queue, no URL required, its reconciliation stays the 5-minute sweep.

export interface PaymentStartDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getProvider: (returnUrl?: string) => Promise<PaymentProviderAdapter & { environment: PhonePeEnvironment }>;
  /** Builds the PRODUCTION fast-reconcile queue client; called only on the PRODUCTION path. */
  getReconcileQueue: (queueUrl: string) => ReconcileQueue;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: PaymentStartDeps = {
  getDb,
  resetDb,
  // Required lazily (the type import above is erased) so a disabled Lambda never even loads the
  // PhonePe SDK; esbuild still bundles the module.
  getProvider: async (returnUrl) =>
    (require('../lib/phonepe-runtime') as typeof PhonePeRuntime).getPhonePePaymentProvider(returnUrl),
  getReconcileQueue: createSqsReconcileQueue,
  env: process.env,
};

/** Only the exact string "true" enables payment initiation; everything else fails closed. */
export function isPaymentStartEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.PAYMENT_START_ENABLED === 'true';
}

/** PHONEPE_ENVIRONMENT from deploy config; anything but an explicit PRODUCTION is treated as
 *  SANDBOX so a missing/typo'd value lands on the stricter gate. */
function configuredEnvironment(env: NodeJS.ProcessEnv): PhonePeEnvironment {
  return env.PHONEPE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX';
}

/** Throws (mapped to a generic 403) unless `identity` may start a payment in `environment`. */
function assertEnvironmentAccess(environment: PhonePeEnvironment, identity: PaymentUserIdentity, env: NodeJS.ProcessEnv): void {
  if (environment === 'PRODUCTION') {
    assertProductionTesterAllowed(identity.sub, env.PHONEPE_PRODUCTION_TESTERS);
    return;
  }
  assertPaymentStartAllowed(environment, identity, env.PHONEPE_SANDBOX_TESTERS);
}

/** Same body as a PhonePe config failure: the caller learns nothing about queues or environments. */
function paymentsUnavailable(): APIGatewayProxyStructuredResultV2 {
  return errorResponse(503, 'payments_unavailable', 'Payments are temporarily unavailable');
}

export function createHandler(deps: PaymentStartDeps = defaultDeps) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    if (!isPaymentStartEnabled(deps.env)) {
      return errorResponse(503, 'payments_temporarily_unavailable', 'Online payments are temporarily unavailable');
    }
    const queueUrl = deps.env.PAYMENT_RECONCILE_QUEUE_URL;
    const hasReconcileQueue = isValidQueueUrl(queueUrl);
    if (configuredEnvironment(deps.env) === 'PRODUCTION' && !hasReconcileQueue) {
      console.error('POST /payments/start: PRODUCTION fast reconciliation queue is not configured');
      return paymentsUnavailable();
    }
    const identity = readIdentity(event);
    if (!identity) {
      return errorResponse(401, 'unauthenticated', 'Missing subject claim');
    }
    const bookingId = parseBookingIdFromBody(event.body, event.isBase64Encoded);
    if (!bookingId) {
      return errorResponse(400, 'invalid_request', 'A valid bookingId is required');
    }

    try {
      assertEnvironmentAccess(configuredEnvironment(deps.env), identity, deps.env);

      const db = await deps.getDb();
      const booking = await findCustomerBooking(db, bookingId, identity.sub);
      if (!booking) {
        // Not found and not-yours look identical on purpose.
        return errorResponse(404, 'booking_not_found', 'Booking not found');
      }

      const baseReturnUrl = getPaymentReturnUrl(deps.env);
      const provider = await deps.getProvider(baseReturnUrl);
      // The secret is the source of truth for which PhonePe environment we are really talking to.
      assertEnvironmentAccess(provider.environment, identity, deps.env);
      const fastReconcile = provider.environment === 'PRODUCTION';
      if (fastReconcile && !hasReconcileQueue) {
        // Deploy config said SANDBOX but the secret is PRODUCTION: still no order without the chain.
        console.error('POST /payments/start: PRODUCTION fast reconciliation queue is not configured');
        return paymentsUnavailable();
      }

      let returnUrl: string | undefined;
      if (baseReturnUrl) {
        const url = new URL(baseReturnUrl);
        url.searchParams.set('bookingId', bookingId);
        returnUrl = url.toString();
      }

      const started = await startPayment(db, provider, {
        bookingId,
        environment: provider.environment,
        checkoutHoldMinutes: getCheckoutHoldMinutes(deps.env),
        returnUrl,
        description: booking.product_name,
      });

      if (!isSafeCheckoutRedirect(started.redirectUrl)) {
        console.error('POST /payments/start: provider returned an unexpected redirect host');
        throw new PaymentProviderError('Provider returned an unexpected redirect URL', false);
      }

      if (fastReconcile) {
        // Only now: the order exists at PhonePe and is persisted locally (startPayment's TX2, or a
        // reused attempt). Throws FastReconcileScheduleError if SQS refuses — no redirect then.
        const chain = await ensureFastReconcileScheduled(db, deps.getReconcileQueue(queueUrl as string), started.paymentId);
        // Hand out the redirect only when a message for the attempt's current link was just sent
        // successfully (first link, or a recovery copy of the current one — a seq > 0 alone does
        // not prove the chain is still alive). An attempt that is no longer open, or whose fast
        // window has already ended, gets the same generic 503.
        if (chain !== 'scheduled' && chain !== 'recovery_scheduled') {
          console.error('POST /payments/start: fast reconciliation not in place', chain);
          return paymentsUnavailable();
        }
      }

      return jsonResponse(200, {
        bookingId,
        bookingNumber: booking.booking_number,
        paymentStatus: 'pending',
        redirectUrl: started.redirectUrl,
        expiresAt: started.expiresAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof FastReconcileScheduleError) {
        // The attempt (and its PhonePe order) stays persisted; a retry reuses it and schedules then.
        console.error('POST /payments/start: fast reconciliation could not be scheduled', err.message);
        return paymentsUnavailable();
      }
      const mapped = mapPaymentError(err);
      if (mapped) {
        // Message only: provider errors are already reduced to status/code by the adapter.
        console.error('POST /payments/start rejected', err instanceof Error ? `${err.name}: ${err.message}` : 'unknown');
        return mapped;
      }
      deps.resetDb();
      console.error('POST /payments/start failed', err instanceof Error ? err.name : 'unknown');
      return errorResponse(500, 'internal_error', 'Failed to start payment');
    }
  };
}

export const handler = createHandler();
