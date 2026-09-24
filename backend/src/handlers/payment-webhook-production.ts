import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import {
  authenticateCallback,
  extractCallbackMerchantOrderId,
  headerValue,
  readRawBody,
  type BoundCallbackValidator,
} from '../lib/phonepe-callback';
import type { PhonePeEnvironment } from '../lib/phonepe-config';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import type * as PhonePeRuntime from '../lib/phonepe-runtime';
import { processProductionPaymentCallback, WEBHOOK_ENVIRONMENT } from '../lib/production-payment-webhook';

// PhonePe cutover Stage 2C: POST /payments/production/webhook — PhonePe's server-to-server callback
// for PRODUCTION orders (playx-dev-payment-webhook-production).
//
// PUBLIC route (no Cognito/JWT authorizer — PhonePe has no token); the ONLY authentication is the
// official SDK's validateCallback() over the Authorization header, using the webhookUsername/
// webhookPassword from the production PhonePe secret (read by lib/phonepe-runtime.ts; never in the
// Lambda environment, never in this handler). The environment is fixed: WEBHOOK_ENVIRONMENT is a
// code constant, cross-checked against the environment the secret itself declares.
//
// Order of work — nothing about the payload is trusted, parsed or logged before validation:
//   400 no body -> 401 no Authorization header (no secret read) -> load credentials (500 if absent
//   or the secret is unusable: fail closed, never accept an unvalidated callback) ->
//   validateCallback on the EXACT raw body (base64-decoded only if API Gateway encoded it)
//   (401 rejected / 400 malformed) -> merchantOrderId from the authenticated payload ->
//   lib/production-payment-webhook.ts: our row, PRODUCTION only, authoritative PhonePe status via
//   the shared reconcilePayment() path.
//
// Responses: every VALID callback we have finished with gets 200 — including an unknown order, a
// non-PRODUCTION row, an already-final attempt or a callback with no merchantOrderId (a refund
// callback) — because a retry could not change the answer. Invalid callbacks get 401/400 with no
// DB or provider work. Unexpected infrastructure failures (secret, DB, PhonePe status API) get 500
// so PhonePe retries. Bodies are generic and name no environment, order or reason.
//
// Logs: only a result code, our payment id and the (format-checked) merchantOrderId. Never the
// Authorization header, the raw body, the callback payload, credentials, tokens or error messages
// from the SDK/JSON parser (which can quote the body).

export interface PaymentWebhookRuntime {
  environment: PhonePeEnvironment;
  provider: PaymentProviderAdapter & { environment: PhonePeEnvironment };
  validateCallback: BoundCallbackValidator;
}

export interface PaymentWebhookDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getRuntime: () => Promise<PaymentWebhookRuntime>;
}

const defaultDeps: PaymentWebhookDeps = {
  getDb,
  resetDb,
  // Required lazily (the type import above is erased) so a request rejected before validation
  // never loads the PhonePe SDK or reads the secret; esbuild still bundles the module.
  getRuntime: async () => (require('../lib/phonepe-runtime') as typeof PhonePeRuntime).getPhonePeWebhookRuntime(),
};

const LOG = 'POST /payments/production/webhook';

function acknowledged(): APIGatewayProxyStructuredResultV2 {
  return jsonResponse(200, { acknowledged: true });
}

function unavailable(): APIGatewayProxyStructuredResultV2 {
  return errorResponse(500, 'internal_error', 'Callback could not be processed');
}

export function createHandler(deps: PaymentWebhookDeps = defaultDeps) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const rawBody = readRawBody(event);
    if (rawBody === null) {
      return errorResponse(400, 'invalid_request', 'Invalid callback');
    }
    const authorization = headerValue(event.headers, 'authorization');
    if (authorization === undefined || authorization.trim().length === 0) {
      return errorResponse(401, 'unauthenticated', 'Invalid callback');
    }

    let runtime: PaymentWebhookRuntime;
    try {
      runtime = await deps.getRuntime();
    } catch (err) {
      const name = err instanceof Error ? err.name : 'unknown';
      console.error(
        name === 'WebhookCredentialsUnavailableError'
          ? `${LOG}: webhook credentials unavailable`
          : `${LOG}: PhonePe configuration unavailable (${name})`,
      );
      return unavailable();
    }
    if (runtime.environment !== WEBHOOK_ENVIRONMENT || runtime.provider.environment !== WEBHOOK_ENVIRONMENT) {
      console.error(`${LOG}: PhonePe configuration is not PRODUCTION`);
      return unavailable();
    }

    const auth = authenticateCallback(runtime.validateCallback, authorization, rawBody);
    if (!auth.ok) {
      console.error(`${LOG}: callback rejected`, JSON.stringify({ reason: auth.reason }));
      return auth.reason === 'malformed'
        ? errorResponse(400, 'invalid_request', 'Invalid callback')
        : errorResponse(401, 'unauthenticated', 'Invalid callback');
    }

    const merchantOrderId = extractCallbackMerchantOrderId(auth.callback);
    if (merchantOrderId === null) {
      console.log(LOG, JSON.stringify({ result: 'no_merchant_order_id' }));
      return acknowledged();
    }

    try {
      const db = await deps.getDb();
      const outcome = await processProductionPaymentCallback({ db, getProvider: async () => runtime.provider }, merchantOrderId);
      const log = outcome.result === 'unknown_order' || outcome.result === 'environment_mismatch' || outcome.result === 'refused'
        ? console.error
        : console.log;
      log(LOG, JSON.stringify({ merchantOrderId, ...outcome }));
      return acknowledged();
    } catch (err) {
      deps.resetDb();
      console.error(`${LOG} failed`, JSON.stringify({ merchantOrderId, error: err instanceof Error ? err.name : 'unknown' }));
      return unavailable();
    }
  };
}

export const handler = createHandler();
