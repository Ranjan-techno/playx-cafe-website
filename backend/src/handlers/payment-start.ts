import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { PaymentProviderError } from '../lib/payment-errors';
import { isSafeCheckoutRedirect, mapPaymentError, parseBookingIdFromBody, readIdentity } from '../lib/payment-http';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import { findCustomerBooking } from '../lib/payment-repository';
import { getCheckoutHoldMinutes, getPaymentReturnUrl } from '../lib/payment-settings';
import type { PhonePeEnvironment } from '../lib/phonepe-config';
import type * as PhonePeRuntime from '../lib/phonepe-runtime';
import { assertPaymentStartAllowed } from '../lib/sandbox-access';
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
//   SANDBOX tester gate (403) -> ownership (404) -> startPayment() -> re-check the gate against
//   the environment the secret ACTUALLY declares.
//
// Kill switch: payment initiation runs only when the Lambda's PAYMENT_START_ENABLED is exactly
// "true" (set explicitly per function in infra/lib/constructs/api.ts). Missing, "false", "TRUE",
// " true" or anything else is disabled — fail closed. While disabled the handler returns a generic
// 503 as its very first step: no DB connection, no Secrets Manager read, no PhonePe SDK load, no
// provider construction, no payment row and no provider call. The response names neither the
// environment nor the reason.

export interface PaymentStartDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getProvider: (returnUrl?: string) => Promise<PaymentProviderAdapter & { environment: PhonePeEnvironment }>;
  env: NodeJS.ProcessEnv;
}

const defaultDeps: PaymentStartDeps = {
  getDb,
  resetDb,
  // Required lazily (the type import above is erased) so a disabled Lambda never even loads the
  // PhonePe SDK; esbuild still bundles the module.
  getProvider: async (returnUrl) =>
    (require('../lib/phonepe-runtime') as typeof PhonePeRuntime).getPhonePePaymentProvider(returnUrl),
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

export function createHandler(deps: PaymentStartDeps = defaultDeps) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    if (!isPaymentStartEnabled(deps.env)) {
      return errorResponse(503, 'payments_temporarily_unavailable', 'Online payments are temporarily unavailable');
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
      assertPaymentStartAllowed(configuredEnvironment(deps.env), identity, deps.env.PHONEPE_SANDBOX_TESTERS);

      const db = await deps.getDb();
      const booking = await findCustomerBooking(db, bookingId, identity.sub);
      if (!booking) {
        // Not found and not-yours look identical on purpose.
        return errorResponse(404, 'booking_not_found', 'Booking not found');
      }

      const baseReturnUrl = getPaymentReturnUrl(deps.env);
      const provider = await deps.getProvider(baseReturnUrl);
      // The secret is the source of truth for which PhonePe environment we are really talking to.
      assertPaymentStartAllowed(provider.environment, identity, deps.env.PHONEPE_SANDBOX_TESTERS);

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

      return jsonResponse(200, {
        bookingId,
        bookingNumber: booking.booking_number,
        paymentStatus: 'pending',
        redirectUrl: started.redirectUrl,
        expiresAt: started.expiresAt.toISOString(),
      });
    } catch (err) {
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
