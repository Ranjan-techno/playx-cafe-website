import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Env, StandardCheckoutClient } from '@phonepe-pg/pg-sdk-node';
import type { DbClient } from '../lib/allocate-simulators';
import { PaymentProviderError } from '../lib/payment-errors';
import type { BoundCallbackValidator } from '../lib/phonepe-callback';
import { PhonePeConfigError } from '../lib/phonepe-config';
import { WebhookCredentialsUnavailableError } from '../lib/phonepe-runtime';
import { startPayment } from '../lib/start-payment';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  seedBooking,
  type FakePaymentDbStore,
} from '../lib/test-support/fake-payment-db';
import { ScriptedProvider } from '../lib/test-support/scripted-provider';
import { createHandler, type PaymentWebhookRuntime } from './payment-webhook-production';

// POST /payments/production/webhook. Callbacks are validated by the REAL SDK
// (StandardCheckoutClient.validateCallback from @phonepe-pg/pg-sdk-node 2.0.6 — a local SHA-256
// check, no network), bound to test-only webhook credentials exactly like phonepe-runtime.ts binds
// the real ones. The DB is the in-memory fake; PhonePe's order-status API is a ScriptedProvider.

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const WEBHOOK_USER = 'SENTINEL-WEBHOOK-USERNAME';
const WEBHOOK_PASS = 'SENTINEL-WEBHOOK-PASSWORD';
const VALID_AUTH = createHash('sha256').update(`${WEBHOOK_USER}:${WEBHOOK_PASS}`).digest('hex');
const PHONEPE_INTERNAL_ORDER_ID = 'OMO2609251130000001';

// The SDK's client is a process-wide singleton; building it performs no network I/O (events off).
const sdkClient = StandardCheckoutClient.getInstance('FAKE-CLIENT', 'FAKE-SECRET', 1, Env.SANDBOX, false);

afterEach(() => mock.timers.reset());

interface World {
  store: FakePaymentDbStore;
  provider: ScriptedProvider;
  handler: ReturnType<typeof createHandler>;
  calls: { getRuntime: number; getDb: number; resetDb: number; queries: string[] };
  validateArgs: [string, string][];
  runtime: PaymentWebhookRuntime;
  /** PRODUCTION booking + its open (pending, live checkout) PRODUCTION PhonePe attempt. */
  bookingId: string;
  orderId: string;
  paymentId: string;
}

async function setup(options: { getRuntime?: () => Promise<PaymentWebhookRuntime>; getDb?: () => Promise<DbClient> } = {}): Promise<World> {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    id: randomUUID(),
    priceInr: '999.00',
    holdExpiresAt: new Date(T0 + 15 * MIN),
    start: new Date(T0 + 24 * 60 * MIN),
    simulatorIds: ['sim-S1'],
    cognitoSub: 'sub-tester',
    bookingEnvironment: 'PRODUCTION',
  });
  const provider = new ScriptedProvider();
  provider.environment = 'PRODUCTION';
  const started = await startPayment(createFakePaymentDbClient(store), provider, {
    bookingId: booking.id,
    environment: 'PRODUCTION',
    checkoutHoldMinutes: 20,
    description: 'Solo Static 30 min',
  });
  provider.createCalls = [];

  const calls = { getRuntime: 0, getDb: 0, resetDb: 0, queries: [] as string[] };
  const validateArgs: [string, string][] = [];
  const validateCallback: BoundCallbackValidator = (authorization, rawBody) => {
    validateArgs.push([authorization, rawBody]);
    return sdkClient.validateCallback(WEBHOOK_USER, WEBHOOK_PASS, authorization, rawBody);
  };
  const runtime: PaymentWebhookRuntime = { environment: 'PRODUCTION', provider, validateCallback };
  const handler = createHandler({
    getRuntime:
      options.getRuntime ??
      (async () => {
        calls.getRuntime += 1;
        return runtime;
      }),
    getDb:
      options.getDb ??
      (async () => {
        calls.getDb += 1;
        const inner = createFakePaymentDbClient(store);
        return {
          query: async <T extends object>(text: string, params?: unknown[]) => {
            calls.queries.push(text);
            return inner.query<T>(text, params);
          },
        } as DbClient;
      }),
    resetDb: () => {
      calls.resetDb += 1;
    },
  });
  return {
    store,
    provider,
    handler,
    calls,
    validateArgs,
    runtime,
    bookingId: booking.id,
    orderId: started.providerOrderId,
    paymentId: started.paymentId,
  };
}

/** A PhonePe v2 order callback body, shaped like the SDK's CallbackResponse/CallbackData. */
function callbackBody(merchantOrderId: string | undefined, state = 'COMPLETED', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: state === 'COMPLETED' ? 'checkout.order.completed' : 'checkout.order.failed',
    type: state === 'COMPLETED' ? 'CHECKOUT_ORDER_COMPLETED' : 'CHECKOUT_ORDER_FAILED',
    payload: {
      merchantId: 'PLAYXMERCHANT',
      ...(merchantOrderId === undefined ? {} : { merchantOrderId }),
      orderId: PHONEPE_INTERNAL_ORDER_ID,
      state,
      amount: 99900,
      expireAt: T0 + 20 * MIN,
      paymentDetails: [{ transactionId: 'CALLBACK-TXN', paymentMode: 'UPI_QR', timestamp: T0, amount: 99900, state }],
      ...extra,
    },
  });
}

function webhookEvent(
  body: string | undefined,
  headers: Record<string, string | undefined> = { authorization: VALID_AUTH },
  isBase64Encoded = false,
): APIGatewayProxyEventV2 {
  return { body, headers, isBase64Encoded, requestContext: {} } as unknown as APIGatewayProxyEventV2;
}

async function call(w: World, event: APIGatewayProxyEventV2) {
  const res = (await w.handler(event)) as { statusCode: number; body: string };
  return { statusCode: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, raw: res.body };
}

/** Runs `fn` with console.log/error captured; returns everything that was logged, as text. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string }> {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const log = mock.method(console, 'log', record);
  const error = mock.method(console, 'error', record);
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    log.mock.restore();
    error.mock.restore();
  }
}

function paidUpdates(w: World): number {
  return w.calls.queries.filter((q) => /SET payment_status = 'paid'/.test(q)).length;
}

function payment(w: World) {
  const row = w.store.payments.find((p) => p.id === w.paymentId);
  assert.ok(row);
  return row;
}

const SUCCESS = { outcome: 'SUCCESS' as const, amountInr: '999.00', currency: 'INR', providerTransactionId: 'TXN-AUTHORITATIVE' };

// ---------------------------------------------------------------- rejected before validation

test('webhook: missing Authorization header -> 401; no secret read, no validation, no DB, no provider call', async () => {
  const w = await setup();
  for (const headers of [{}, { authorization: undefined }, { authorization: '' }, { authorization: '   ' }, { 'x-authorization': VALID_AUTH }]) {
    const res = await call(w, webhookEvent(callbackBody(w.orderId), headers));
    assert.equal(res.statusCode, 401, JSON.stringify(headers));
  }
  assert.equal(w.calls.getRuntime, 0, 'credentials never loaded');
  assert.equal(w.validateArgs.length, 0);
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.provider.statusCalls.length, 0);
});

test('webhook: missing / empty body -> 400 before anything else', async () => {
  const w = await setup();
  for (const [body, b64] of [[undefined, false], ['', false], ['', true]] as const) {
    const res = await call(w, webhookEvent(body, { authorization: VALID_AUTH }, b64));
    assert.equal(res.statusCode, 400);
  }
  assert.equal(w.calls.getRuntime + w.calls.getDb, 0);
});

test('webhook: the Authorization header is found case-insensitively and passed to the SDK exactly as received', async () => {
  for (const name of ['authorization', 'Authorization', 'AUTHORIZATION', 'aUtHoRiZaTiOn']) {
    const w = await setup();
    w.provider.statuses.set(w.orderId, { outcome: 'PENDING' });
    const res = await call(w, webhookEvent(callbackBody(w.orderId), { 'content-type': 'application/json', [name]: VALID_AUTH }));
    assert.equal(res.statusCode, 200, name);
    assert.equal(w.validateArgs[0][0], VALID_AUTH);
  }
});

// ---------------------------------------------------------------- SDK validation

test('webhook: invalid Authorization -> 401 from the real SDK check; NO DB work and NO status call', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const wrong = [
    createHash('sha256').update(`${WEBHOOK_USER}:wrong-password`).digest('hex'),
    VALID_AUTH.toUpperCase(),
    `SHA256 ${VALID_AUTH}`,
    'Bearer something',
    `${WEBHOOK_USER}:${WEBHOOK_PASS}`,
  ];
  for (const authorization of wrong) {
    const { result: res } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId), { authorization })));
    assert.equal(res.statusCode, 401, authorization);
    assert.equal(res.body.error, 'unauthenticated');
  }
  assert.equal(w.calls.getDb, 0, 'the database is never touched for an invalid callback');
  assert.equal(w.provider.statusCalls.length, 0, 'PhonePe status is never queried for an invalid callback');
  assert.equal(payment(w).payment_status, 'pending');
  assert.equal(w.store.bookings[0].status, 'pending');
});

test('webhook: a malformed body is rejected (400) only after the SDK accepted the header; an invalid header on a malformed body is still 401', async () => {
  const w = await setup();
  for (const body of ['{not json', '{"payload":', 'null', '[]', '"just a string"', '42']) {
    const { result: res } = await captureLogs(() => call(w, webhookEvent(body)));
    assert.equal(res.statusCode, 400, body);
    const { result: unauth } = await captureLogs(() => call(w, webhookEvent(body, { authorization: 'nope' })));
    assert.equal(unauth.statusCode, 401, `${body}: header checked first`);
  }
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.provider.statusCalls.length, 0);
});

test('webhook: validateCallback receives the EXACT raw body string (whitespace, key order and unicode untouched)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, { outcome: 'PENDING' });
  const raw = `  {\n  "payload" : { "state":"COMPLETED",  "merchantOrderId" : "${w.orderId}", "note": "café ₹" },\n "type":"CHECKOUT_ORDER_COMPLETED"}\n`;
  const res = await call(w, webhookEvent(raw));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.validateArgs, [[VALID_AUTH, raw]]);
});

test('webhook: an API Gateway base64-encoded body is decoded before validation — the SDK sees the original bytes', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const raw = callbackBody(w.orderId).replace('"merchantId"', '"note":"café ₹","merchantId"');
  const res = await call(w, webhookEvent(Buffer.from(raw, 'utf8').toString('base64'), { authorization: VALID_AUTH }, true));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.validateArgs, [[VALID_AUTH, raw]]);
  assert.equal(payment(w).payment_status, 'paid');
});

test('webhook: a base64 flag on a non-JSON payload fails validation parsing (400), never processed as-is', async () => {
  const w = await setup();
  const raw = callbackBody(w.orderId);
  // Claimed base64 but actually plain JSON: decoding yields garbage, which the SDK cannot parse.
  const { result: res } = await captureLogs(() => call(w, webhookEvent(raw, { authorization: VALID_AUTH }, true)));
  assert.equal(res.statusCode, 400);
  assert.equal(w.calls.getDb, 0);
});

// ---------------------------------------------------------------- credentials / configuration

test('webhook: missing webhook credentials fail closed (500), log only that they are unavailable, never validate or touch the DB', async () => {
  const w = await setup({ getRuntime: async () => { throw new WebhookCredentialsUnavailableError(); } });
  const { result: res, logs } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
  assert.equal(res.statusCode, 500);
  assert.ok(!/credential|webhook|PRODUCTION/i.test(res.raw), 'generic body');
  assert.match(logs, /webhook credentials unavailable/);
  assert.ok(!logs.includes(VALID_AUTH));
  assert.equal(w.validateArgs.length, 0);
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(payment(w).payment_status, 'pending');
});

test('webhook: an unusable secret or a non-PRODUCTION secret -> 500 with no validation and no DB work', async () => {
  const configError = await setup({ getRuntime: async () => { throw new PhonePeConfigError('PhonePe secret is not valid JSON'); } });
  const { result: res } = await captureLogs(() => call(configError, webhookEvent(callbackBody(configError.orderId))));
  assert.equal(res.statusCode, 500);
  assert.equal(configError.calls.getDb, 0);

  const w = await setup();
  const sandboxRuntime: PaymentWebhookRuntime = { ...w.runtime, environment: 'SANDBOX' };
  const sandbox = await setup({ getRuntime: async () => sandboxRuntime });
  const { result: sandboxRes } = await captureLogs(() => call(sandbox, webhookEvent(callbackBody(w.orderId))));
  assert.equal(sandboxRes.statusCode, 500);
  assert.equal(w.validateArgs.length, 0, 'never validated against a sandbox configuration');
  assert.equal(sandbox.calls.getDb, 0);
});

// ---------------------------------------------------------------- merchant order id

test('webhook: the lookup key is payload.merchantOrderId (our order id), never PhonePe\'s internal payload.orderId', async () => {
  const w = await setup();
  // A second PRODUCTION attempt whose provider_order_id equals PhonePe's internal id in the callback.
  const decoy = { ...payment(w), id: randomUUID(), provider_order_id: PHONEPE_INTERNAL_ORDER_ID, metadata: { ...payment(w).metadata } };
  w.store.payments.push(decoy);
  w.provider.statuses.set(w.orderId, SUCCESS);
  const res = await call(w, webhookEvent(callbackBody(w.orderId)));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.provider.statusCalls, [w.orderId], 'status asked for OUR merchant order id only');
  assert.equal(payment(w).payment_status, 'paid');
  assert.equal(decoy.payment_status, 'pending', 'the row matching PhonePe\'s internal id is untouched');
});

test('webhook: an authenticated callback without a usable merchantOrderId is acknowledged (200) with no DB or provider work', async () => {
  const w = await setup();
  const bodies = [
    callbackBody(undefined), // order callback missing merchantOrderId (only orderId present)
    callbackBody(''),
    callbackBody('has spaces'),
    callbackBody('x'.repeat(64)),
    callbackBody(undefined, 'COMPLETED', { merchantOrderId: 12345 }),
    // refund callbacks: originalMerchantOrderId is never used as a lookup key
    callbackBody(undefined, 'COMPLETED', { originalMerchantOrderId: w.orderId, merchantRefundId: 'R-1', refundId: 'OMR-1' }),
    callbackBody(w.orderId, 'COMPLETED', { merchantRefundId: 'R-2' }),
    JSON.stringify({ type: 'CHECKOUT_ORDER_COMPLETED' }),
    JSON.stringify({ payload: [w.orderId] }),
  ];
  for (const body of bodies) {
    const { result: res } = await captureLogs(() => call(w, webhookEvent(body)));
    assert.equal(res.statusCode, 200, body);
  }
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(payment(w).payment_status, 'pending');
});

// ---------------------------------------------------------------- environment / unknown order

test('webhook: a SANDBOX local payment is never processed (200, no production status call, row untouched)', async () => {
  const w = await setup();
  payment(w).payment_environment = 'SANDBOX';
  w.provider.statuses.set(w.orderId, SUCCESS);
  const { result: res, logs } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(payment(w).payment_status, 'pending');
  assert.equal(w.store.bookings[0].status, 'pending');
  assert.match(logs, /environment_mismatch/);
});

test('webhook: a NULL/unknown payment environment is treated like a mismatch (no status call)', async () => {
  for (const env of [null, 'LIVE']) {
    const w = await setup();
    payment(w).payment_environment = env as never;
    w.provider.statuses.set(w.orderId, SUCCESS);
    const { result: res } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
    assert.equal(res.statusCode, 200);
    assert.equal(w.provider.statusCalls.length, 0);
    assert.equal(payment(w).payment_status, 'pending');
  }
});

test('webhook: an unknown PRODUCTION merchant order id -> 200 (no retry storm), sanitized log, no provider call', async () => {
  const w = await setup();
  const unknown = randomUUID();
  const { result: res, logs } = await captureLogs(() => call(w, webhookEvent(callbackBody(unknown))));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { acknowledged: true });
  assert.equal(w.provider.statusCalls.length, 0);
  assert.match(logs, /unknown_order/);
  assert.ok(logs.includes(unknown), 'our own (format-checked) merchant reference is logged');
  assert.ok(!logs.includes(PHONEPE_INTERNAL_ORDER_ID) && !logs.includes('CALLBACK-TXN'), 'no payload fields logged');
});

// ---------------------------------------------------------------- authoritative status

test('webhook: COMPLETED callback + authoritative COMPLETED -> confirmed through reconcilePayment (booking + allocations confirmed)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const res = await call(w, webhookEvent(callbackBody(w.orderId)));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(w.provider.statusCalls, [w.orderId], 'exactly one authoritative getOrderStatus');
  assert.equal(payment(w).payment_status, 'paid');
  assert.equal(payment(w).provider_transaction_id, 'TXN-AUTHORITATIVE', 'the status API\'s transaction id, not the callback\'s');
  assert.equal(w.store.bookings[0].status, 'confirmed');
  assert.ok(w.store.allocations.every((a) => a.allocation_status === 'confirmed'));
  assert.equal(paidUpdates(w), 1);
});

test('webhook: callback says COMPLETED but the authoritative status is PENDING -> stays pending, booking untouched', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, { outcome: 'PENDING' });
  const res = await call(w, webhookEvent(callbackBody(w.orderId, 'COMPLETED')));
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.statusCalls.length, 1);
  assert.equal(payment(w).payment_status, 'pending');
  assert.equal(w.store.bookings[0].status, 'pending');
  assert.ok(w.store.allocations.every((a) => a.allocation_status === 'hold'));
  assert.equal(paidUpdates(w), 0);
});

test('webhook: callback says COMPLETED but the authoritative amount does not match -> refused (acknowledged), NOT paid', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, { ...SUCCESS, amountInr: '1.00' });
  const { result: res, logs } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
  assert.equal(res.statusCode, 200);
  assert.notEqual(payment(w).payment_status, 'paid');
  assert.equal(w.store.bookings[0].status, 'pending');
  assert.match(logs, /refused/);
});

test('webhook: authoritative FAILED -> payment failed, booking left pending (same domain path)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, { outcome: 'FAILED', failureReason: 'PAYMENT_ERROR' });
  const res = await call(w, webhookEvent(callbackBody(w.orderId, 'FAILED')));
  assert.equal(res.statusCode, 200);
  assert.equal(payment(w).payment_status, 'failed');
  assert.equal(w.store.bookings[0].status, 'pending');
});

// ---------------------------------------------------------------- idempotency

test('webhook: a duplicate COMPLETED callback confirms only once (second one: no status call, no second paid write)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const first = await call(w, webhookEvent(callbackBody(w.orderId)));
  const second = await call(w, webhookEvent(callbackBody(w.orderId)));
  const third = await call(w, webhookEvent(callbackBody(w.orderId)));
  for (const res of [first, second, third]) {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { acknowledged: true });
  }
  assert.equal(w.provider.statusCalls.length, 1, 'only the first callback needed PhonePe');
  assert.equal(paidUpdates(w), 1, 'one confirmation');
  assert.equal(w.store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(w.store.allocations.filter((a) => a.allocation_status === 'confirmed').length, 1, 'no double allocation');
});

test('webhook: concurrent duplicate COMPLETED callbacks still confirm exactly once (row lock + alreadyConfirmed)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const { result: results, logs } = await captureLogs(() =>
    Promise.all([1, 2, 3].map(() => call(w, webhookEvent(callbackBody(w.orderId))))),
  );
  assert.deepEqual(results.map((r) => r.statusCode), [200, 200, 200]);
  assert.equal(paidUpdates(w), 1, 'exactly one paid write');
  assert.equal(w.store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(w.store.bookings[0].status, 'confirmed');
  assert.equal(w.store.allocations.filter((a) => a.allocation_status === 'confirmed').length, 1);
  assert.match(logs, /"alreadyConfirmed":true/, 'a racing duplicate saw the confirmation, not a second one');
});

test('webhook: callbacks for already failed / expired / refunded attempts are acknowledged with no status call and no reversal', async () => {
  for (const status of ['failed', 'expired', 'refunded'] as const) {
    const w = await setup();
    payment(w).payment_status = status;
    w.provider.statuses.set(w.orderId, SUCCESS);
    const res = await call(w, webhookEvent(callbackBody(w.orderId)));
    assert.equal(res.statusCode, 200, status);
    assert.equal(w.provider.statusCalls.length, 0, status);
    assert.equal(payment(w).payment_status, status, `${status} is never reversed`);
    assert.equal(w.store.bookings[0].status, 'pending');
  }
});

test('webhook: a pending attempt that is still pending stays pending across retried callbacks (one status call each)', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, { outcome: 'PENDING' });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call(w, webhookEvent(callbackBody(w.orderId)))).statusCode, 200);
  }
  assert.equal(w.provider.statusCalls.length, 3);
  assert.equal(payment(w).payment_status, 'pending');
  // ...and once PhonePe reports COMPLETED, the next retry confirms.
  w.provider.statuses.set(w.orderId, SUCCESS);
  assert.equal((await call(w, webhookEvent(callbackBody(w.orderId)))).statusCode, 200);
  assert.equal(payment(w).payment_status, 'paid');
});

// ---------------------------------------------------------------- infrastructure failures

test('webhook: PhonePe status API failure -> 500 so PhonePe retries; nothing changed', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, new PaymentProviderError('PhonePe order status failed (HTTP 503)', false, 503));
  const { result: res } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
  assert.equal(res.statusCode, 500);
  assert.ok(!/PhonePe|503|status/i.test(String(res.body.message)), 'generic body');
  assert.equal(payment(w).payment_status, 'pending');
  // The retry succeeds once PhonePe is back.
  w.provider.statuses.set(w.orderId, SUCCESS);
  assert.equal((await call(w, webhookEvent(callbackBody(w.orderId)))).statusCode, 200);
  assert.equal(payment(w).payment_status, 'paid');
});

test('webhook: database failure after a valid callback -> 500 and the DB connection is reset', async () => {
  const w = await setup({ getDb: async () => { throw new Error('ECONNREFUSED 10.0.0.1:5432'); } });
  const { result: res, logs } = await captureLogs(() => call(w, webhookEvent(callbackBody(w.orderId))));
  assert.equal(res.statusCode, 500);
  assert.equal(w.calls.resetDb, 1);
  assert.ok(!logs.includes('10.0.0.1'), 'error messages are not logged, only names');
});

// ---------------------------------------------------------------- logging hygiene

test('webhook: never logs the Authorization header, credentials, raw body, payload fields or parser messages', async () => {
  const w = await setup();
  w.provider.statuses.set(w.orderId, SUCCESS);
  const secretBody = callbackBody(w.orderId, 'COMPLETED', { note: 'RAW-BODY-SENTINEL' });
  const { logs } = await captureLogs(async () => {
    await call(w, webhookEvent(secretBody, { authorization: 'WRONG-AUTH-SENTINEL' }));
    await call(w, webhookEvent('{"RAW-BODY-SENTINEL": '));
    await call(w, webhookEvent(callbackBody(randomUUID(), 'COMPLETED', { note: 'RAW-BODY-SENTINEL' })));
    await call(w, webhookEvent(secretBody));
    await call(w, webhookEvent(secretBody));
  });
  assert.ok(logs.length > 0);
  for (const forbidden of [VALID_AUTH, 'WRONG-AUTH-SENTINEL', WEBHOOK_USER, WEBHOOK_PASS, 'RAW-BODY-SENTINEL', 'CALLBACK-TXN', PHONEPE_INTERNAL_ORDER_ID, 'FAKE-SECRET', 'Unexpected', 'JSON']) {
    assert.ok(!logs.includes(forbidden), `log must not contain ${forbidden}`);
  }
});

test('webhook: the handler module never statically imports the PhonePe runtime/SDK (rejected requests never load credentials)', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./payment-webhook-production.ts'), 'utf8') as string;
  assert.doesNotMatch(src, /^import (?!type )[^;]*phonepe-runtime/m);
  assert.doesNotMatch(src, /^import (?!type )[^;]*@phonepe-pg/m);
  assert.match(src, /require\('\.\.\/lib\/phonepe-runtime'\)/);
  assert.doesNotMatch(src, /process\.env/, 'no configuration read from the environment in the handler');
});
