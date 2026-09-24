import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { PaymentProviderError, PaymentProviderOrderNotFoundError } from '../lib/payment-errors';
import type { CreatePaymentRequest, CreatePaymentResult } from '../lib/payment-provider';
import { markPaymentPaid } from '../lib/payment-repository';
import { PhonePeConfigError } from '../lib/phonepe-config';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  seedBooking,
  type FakePaymentDbStore,
} from '../lib/test-support/fake-payment-db';
import { ScriptedProvider } from '../lib/test-support/scripted-provider';
import { createHandler as createStartHandler } from './payment-start';
import { createHandler as createStatusHandler } from './payment-status';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const ME = 'sub-alice';
const OTHER = 'sub-bob';
const SECRET_SENTINEL = 'SUPER-SECRET-CLIENT-SECRET';

afterEach(() => mock.timers.reset());

/** ScriptedProvider that behaves like the PhonePe adapter: knows its environment, hands back a
 *  phonepe.com checkout URL. */
class TestProvider extends ScriptedProvider {
  environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX';
  redirectUrlOverride?: string;
  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const result = await super.createPayment(request);
    return {
      ...result,
      redirectUrl: this.redirectUrlOverride ?? `https://mercury-uat.phonepe.com/checkout/${request.providerOrderId}`,
      raw: { clientSecret: SECRET_SENTINEL },
    };
  }
}

interface World {
  store: FakePaymentDbStore;
  provider: TestProvider;
  bookingId: string;
  start: ReturnType<typeof createStartHandler>;
  status: ReturnType<typeof createStatusHandler>;
  env: NodeJS.ProcessEnv;
}

function setup(envOverrides: NodeJS.ProcessEnv = {}, seed: Parameters<typeof seedBooking>[1] extends infer S ? Partial<S> : never = {}): World {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    id: randomUUID(),
    priceInr: '999.00',
    holdExpiresAt: new Date(T0 + 15 * MIN),
    start: new Date(T0 + 24 * 60 * MIN),
    simulatorIds: ['sim-S1'],
    cognitoSub: ME,
    bookingNumber: 1001,
    ...seed,
  });
  const provider = new TestProvider();
  const env: NodeJS.ProcessEnv = {
    PHONEPE_ENVIRONMENT: 'SANDBOX',
    PHONEPE_SANDBOX_TESTERS: ME,
    PAYMENT_RETURN_URL: 'https://staging.playxcafe.com/payment-return.html',
    ...envOverrides,
  };
  const deps = {
    getDb: async () => createFakePaymentDbClient(store),
    resetDb: () => {},
    getProvider: async () => provider,
  };
  return {
    store,
    provider,
    bookingId: booking.id,
    env,
    start: createStartHandler({ ...deps, env }),
    status: createStatusHandler(deps),
  };
}

function startEvent(body: unknown, claims: Record<string, unknown> | null = { sub: ME }): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: claims === null ? {} : { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function statusEvent(bookingId: string | undefined, claims: Record<string, unknown> | null = { sub: ME }): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: bookingId === undefined ? {} : { bookingId },
    requestContext: claims === null ? {} : { authorizer: { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

async function call<R>(fn: () => Promise<R>): Promise<{ statusCode: number; body: Record<string, unknown>; raw: string }> {
  const res = (await fn()) as { statusCode: number; body: string };
  return { statusCode: res.statusCode, body: JSON.parse(res.body), raw: res.body };
}

// ---------------------------------------------------------------- POST /payments/start

test('start: no JWT claims -> 401 and nothing touched', async () => {
  const w = setup();
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId }, null)));
  assert.equal(res.statusCode, 401);
  assert.equal(w.provider.createCalls.length, 0);
});

test('start: malformed / missing bookingId -> 400', async () => {
  const w = setup();
  for (const body of [{ bookingId: 'not-a-uuid' }, {}, { bookingId: 42 }, '{oops', '[]', '']) {
    const res = await call(() => w.start(startEvent(body)));
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(w.provider.createCalls.length, 0);
});

test('start: returns only the safe shape; amount comes from the DB, not the request', async () => {
  const w = setup();
  const res = await call(() =>
    w.start(startEvent({ bookingId: w.bookingId, amount: 1, price: 1, status: 'paid', environment: 'PRODUCTION', redirectUrl: 'https://evil.test', simulatorId: 'x' })),
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(res.body).sort(), ['bookingId', 'bookingNumber', 'expiresAt', 'paymentStatus', 'redirectUrl']);
  assert.equal(res.body.bookingNumber, 1001);
  assert.equal(res.body.paymentStatus, 'pending');
  assert.match(String(res.body.redirectUrl), /^https:\/\/mercury-uat\.phonepe\.com\//);
  assert.equal(w.provider.createCalls.length, 1);
  assert.equal(w.provider.createCalls[0].amountInr, '999.00', 'amount is bookings.price_inr');
  assert.equal(w.store.payments[0].amount_inr, '999.00');
  assert.equal(w.store.payments[0].metadata?.environment, 'SANDBOX', 'environment is config, not request');
  assert.equal(w.store.payments[0].metadata?.paymentEnvironment, 'SANDBOX', 'marker comes from the PhonePe config, not the request body claiming PRODUCTION');
  const returnUrl = new URL(String(w.provider.createCalls[0].returnUrl));
  assert.equal(returnUrl.origin + returnUrl.pathname, 'https://staging.playxcafe.com/payment-return.html');
  assert.equal(returnUrl.searchParams.get('bookingId'), w.bookingId);
});

test('start: provider raw response / secrets never appear in the body', async () => {
  const w = setup();
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.ok(!res.raw.includes(SECRET_SENTINEL));
  assert.ok(!/clientSecret|clientId|authorization|metadata/i.test(res.raw));
});

test('start: another customer\'s booking -> 404, no provider call, nothing written', async () => {
  const w = setup({ PHONEPE_SANDBOX_TESTERS: `${ME},${OTHER}` });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId }, { sub: OTHER })));
  assert.equal(res.statusCode, 404);
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('start: unknown booking -> 404', async () => {
  const w = setup();
  const res = await call(() => w.start(startEvent({ bookingId: '00000000-0000-4000-8000-000000000000' })));
  assert.equal(res.statusCode, 404);
});

test('SANDBOX: missing / blank tester list denies everyone (fail closed)', async () => {
  for (const testers of [undefined, '', '  , ,']) {
    const w = setup({ PHONEPE_SANDBOX_TESTERS: testers });
    const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, 'payments_not_permitted');
    assert.equal(w.provider.createCalls.length, 0);
  }
});

test('SANDBOX: listed sub is allowed', async () => {
  const w = setup({ PHONEPE_SANDBOX_TESTERS: `someone-else, ${ME}` });
  assert.equal((await call(() => w.start(startEvent({ bookingId: w.bookingId })))).statusCode, 200);
});

test('SANDBOX: listed VERIFIED email is allowed; unverified email is not', async () => {
  const w = setup({ PHONEPE_SANDBOX_TESTERS: 'Tester@Example.com' });
  const ok = await call(() => w.start(startEvent({ bookingId: w.bookingId }, { sub: ME, email: 'tester@example.com', email_verified: 'true' })));
  assert.equal(ok.statusCode, 200);
  const w2 = setup({ PHONEPE_SANDBOX_TESTERS: 'tester@example.com' });
  const denied = await call(() => w2.start(startEvent({ bookingId: w2.bookingId }, { sub: ME, email: 'tester@example.com', email_verified: false })));
  assert.equal(denied.statusCode, 403);
});

test('SANDBOX: a normal, unlisted production customer cannot start a sandbox payment', async () => {
  const w = setup({ PHONEPE_SANDBOX_TESTERS: 'sub-the-tester' });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId }, { sub: ME, email: 'customer@gmail.com', email_verified: true })));
  assert.equal(res.statusCode, 403);
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('start: SANDBOX config writes typed payment_environment=SANDBOX and mirrors metadata; request cannot choose it', async () => {
  const w = setup();
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId, paymentEnvironment: 'PRODUCTION', payment_environment: 'PRODUCTION', environment: 'PRODUCTION' })));
  assert.equal(res.statusCode, 200);
  assert.equal(w.store.payments[0].payment_environment, 'SANDBOX');
  assert.equal(w.store.payments[0].metadata?.paymentEnvironment, 'SANDBOX');
});

test('start: a NULL booking environment is refused by the sandbox payment path (409, no provider call, nothing written)', async () => {
  const w = setup({}, { bookingEnvironment: null });
  const err = mock.method(console, 'error', () => {});
  try {
    const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'booking_not_payable');
  } finally {
    err.mock.restore();
  }
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('start: a PRODUCTION booking is refused by the sandbox payment path (409, no provider call, nothing written)', async () => {
  const w = setup({}, { bookingEnvironment: 'PRODUCTION' });
  const err = mock.method(console, 'error', () => {});
  try {
    const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.error, 'booking_not_payable');
    assert.ok(!/SANDBOX|PRODUCTION|environment/i.test(res.raw), 'no environment detail leaked');
  } finally {
    err.mock.restore();
  }
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('start: environment comes from the provider config — a PRODUCTION config needs a PRODUCTION booking; NULL never matches PRODUCTION', async () => {
  const ok = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION' }, { bookingEnvironment: 'PRODUCTION' });
  ok.provider.environment = 'PRODUCTION';
  const res = await call(() => ok.start(startEvent({ bookingId: ok.bookingId, paymentEnvironment: 'SANDBOX', environment: 'SANDBOX' })));
  assert.equal(res.statusCode, 200);
  assert.equal(ok.store.payments[0].payment_environment, 'PRODUCTION');
  assert.equal(ok.store.payments[0].metadata?.paymentEnvironment, 'PRODUCTION');

  const err = mock.method(console, 'error', () => {});
  try {
    for (const bookingEnvironment of ['SANDBOX', null] as const) {
      const w = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION' }, { bookingEnvironment });
      w.provider.environment = 'PRODUCTION';
      const denied = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
      assert.equal(denied.statusCode, 409, String(bookingEnvironment));
      assert.equal(w.store.payments.length, 0);
      assert.equal(w.provider.createCalls.length, 0);
    }
  } finally {
    err.mock.restore();
  }
});

test('SANDBOX gate is re-checked against the environment the secret actually declares', async () => {
  // Deploy config says PRODUCTION (no gate up front) but the secret is a SANDBOX one: still gated.
  const w = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION', PHONEPE_SANDBOX_TESTERS: '' });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 403);
  assert.equal(w.provider.createCalls.length, 0);
});

test('start: provider 4xx -> sanitized 502; body has no provider detail', async () => {
  const w = setup();
  w.provider.createError = new PaymentProviderError(`PhonePe create order failed (HTTP 400) [${SECRET_SENTINEL}]`, true, 400, 'X');
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'payment_provider_error');
  assert.ok(!res.raw.includes(SECRET_SENTINEL) && !res.raw.includes('400'));
});

test('start: provider timeout / 5xx -> sanitized 503', async () => {
  const w = setup();
  w.provider.createError = new PaymentProviderError('PhonePe create order failed (HTTP 503) [secret-ish]', false, 503);
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payment_provider_unavailable');
  assert.ok(!res.raw.includes('secret-ish'));
});

test('start: secret/config failure -> 503 payments_unavailable, unexpected error -> generic 500', async () => {
  const w = setup();
  const deps = { getDb: async () => createFakePaymentDbClient(w.store), resetDb: () => {}, env: w.env };
  const cfg = createStartHandler({ ...deps, getProvider: async () => { throw new PhonePeConfigError(`bad ${SECRET_SENTINEL}`); } });
  const a = await call(() => cfg(startEvent({ bookingId: w.bookingId })));
  assert.equal(a.statusCode, 503);
  assert.ok(!a.raw.includes(SECRET_SENTINEL));

  let reset = 0;
  const boom = createStartHandler({ ...deps, resetDb: () => { reset += 1; }, getProvider: async () => { throw new Error(`pg: password=${SECRET_SENTINEL}`); } });
  const b = await call(() => boom(startEvent({ bookingId: w.bookingId })));
  assert.equal(b.statusCode, 500);
  assert.equal(b.body.error, 'internal_error');
  assert.ok(!b.raw.includes(SECRET_SENTINEL));
  assert.equal(reset, 1);
});

test('start: non-PhonePe redirect host is never handed to the browser', async () => {
  const w = setup();
  w.provider.redirectUrlOverride = 'https://evil.example/phish';
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 503);
  assert.ok(!res.raw.includes('evil.example'));
});

test('start: booking not pending -> 409', async () => {
  const w = setup({}, { status: 'confirmed' });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'booking_not_payable');
});

test('start: second start reuses the live attempt (no second provider order)', async () => {
  const w = setup();
  const a = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  const b = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(b.statusCode, 200);
  assert.equal(b.body.redirectUrl, a.body.redirectUrl);
  assert.equal(w.provider.createCalls.length, 1);
});

// ---------------------------------------------------------------- GET /payments/{id}/status

async function started(w: World) {
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  return w.store.payments[0];
}

test('status: no JWT -> 401; malformed id -> 400', async () => {
  const w = setup();
  assert.equal((await call(() => w.status(statusEvent(w.bookingId, null)))).statusCode, 401);
  assert.equal((await call(() => w.status(statusEvent('nope')))).statusCode, 400);
  assert.equal((await call(() => w.status(statusEvent(undefined)))).statusCode, 400);
});

test('status: another customer\'s booking cannot be queried (404, no provider call)', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'T1' });
  const res = await call(() => w.status(statusEvent(w.bookingId, { sub: OTHER })));
  assert.equal(res.statusCode, 404);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.store.payments[0].payment_status, 'pending', 'a stranger cannot trigger reconciliation');
});

test('status: nothing started yet -> not_started, retryable', async () => {
  const w = setup();
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    bookingId: w.bookingId, bookingNumber: 1001, bookingStatus: 'pending', paymentStatus: null,
    outcome: 'not_started', holdExpiresAt: new Date(T0 + 15 * MIN).toISOString(), canRetry: true,
  });
});

test('status: provider still PENDING -> pending, booking untouched', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'PENDING' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'pending');
  assert.equal(res.body.paymentStatus, 'pending');
  assert.equal(res.body.bookingStatus, 'pending');
  assert.equal(res.body.canRetry, false);
  assert.equal(w.provider.statusCalls.length, 1);
});

test('status: provider COMPLETED with the right amount -> paid + booking confirmed', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TXN-1' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(res.body.paymentStatus, 'paid');
  assert.equal(res.body.bookingStatus, 'confirmed');
  assert.equal(w.store.allocations.every((a) => a.allocation_status === 'confirmed'), true);
  assert.ok(!res.raw.includes('TXN-1'), 'provider transaction id is not exposed');
  // idempotent: polling again does not call the provider or change anything
  const again = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(again.body.outcome, 'confirmed');
  assert.equal(w.provider.statusCalls.length, 1);
});

test('status: browser return alone is never proof — an amount mismatch does not confirm', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '1.00', currency: 'INR', providerTransactionId: 'TXN-2' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 200);
  assert.notEqual(res.body.outcome, 'confirmed');
  assert.equal(res.body.bookingStatus, 'pending');
  assert.notEqual(w.store.payments[0].payment_status, 'paid');
});

test('status: provider FAILED -> failed and retryable', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'FAILED', failureReason: 'PAYMENT_ERROR' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'failed');
  assert.equal(res.body.paymentStatus, 'failed');
  assert.equal(res.body.canRetry, true);
  assert.ok(!res.raw.includes('PAYMENT_ERROR'), 'failure detail is not exposed');
});

test('status: late success after the hold lapsed and capacity was taken -> refund_required, safely', async () => {
  const w = setup();
  const payment = await started(w);
  // Hold lapses (and is released), then another booking takes the only static rig for that slot.
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 + 60 * MIN });
  for (const a of w.store.allocations) {
    a.allocation_status = 'released';
    a.hold_expires_at = null;
  }
  const sameStart = w.store.bookings[0].scheduled_start_at;
  for (const sim of ['sim-S1', 'sim-S2']) {
    seedBooking(w.store, { priceInr: '999.00', start: sameStart, simulatorIds: [sim], allocationStatus: 'confirmed', status: 'confirmed', cognitoSub: OTHER });
  }
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'LATE-1' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'refund_required');
  assert.equal(res.body.paymentStatus, 'paid');
  assert.notEqual(res.body.bookingStatus, 'confirmed');
  assert.equal(res.body.canRetry, false);
  assert.ok(!/refundRequired|metadata|LATE-1/.test(res.raw), 'internal flags are not leaked');
});

test('status: late success while capacity is still free -> confirmed', async () => {
  const w = setup();
  const payment = await started(w);
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 + 60 * MIN });
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'LATE-2' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(res.body.bookingStatus, 'confirmed');
});

test('status: hold lapsed, nothing pending -> hold_expired', async () => {
  const w = setup();
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 + 30 * MIN });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'hold_expired');
  assert.equal(res.body.canRetry, false);
});

test('status: provider outage while polling -> 200 with last known state, no state change, no detail', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, new PaymentProviderError(`HTTP 503 ${SECRET_SENTINEL}`, false, 503));
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'pending');
  assert.ok(!res.raw.includes(SECRET_SENTINEL));
  w.provider.statuses.set(payment.provider_order_id, new PaymentProviderOrderNotFoundError());
  assert.equal((await call(() => w.status(statusEvent(w.bookingId)))).body.outcome, 'pending');
  assert.equal(w.store.payments[0].payment_status, 'pending');
});

test('status: an already-paid booking is not re-reconciled with the provider', async () => {
  const w = setup();
  const payment = await started(w);
  const db = createFakePaymentDbClient(w.store);
  await markPaymentPaid(db, payment.id, 'T-9', null);
  w.store.bookings[0].status = 'confirmed';
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(w.provider.statusCalls.length, 0);
});

test('status: a duplicate paid row (column) never becomes the current payment; primary stays primary', async () => {
  const w = setup();
  const payment = await started(w);
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'T-P' });
  await call(() => w.status(statusEvent(w.bookingId)));
  const primary = w.store.payments[0];
  // A later duplicate, newer than the primary, flagged only via the column.
  w.store.payments.push({ ...primary, id: randomUUID(), provider_order_id: 'dup-order', payment_status: 'paid', duplicate_of_payment_id: primary.id, metadata: {}, created_at: new Date(primary.created_at.getTime() + 1000) });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.paymentStatus, 'paid');
  assert.equal(res.body.outcome, 'confirmed', 'duplicate row is not reported as the current payment');
  assert.equal(w.store.allocations.filter((a) => a.allocation_status === 'confirmed').length, w.store.allocations.length, 'no double allocation');
});

// ---------------------------------------------------------------- status: environment protection

test('status: sandbox provider refuses to reconcile an explicitly PRODUCTION payment (no provider call, no state change)', async () => {
  const w = setup();
  const payment = await started(w);
  w.store.payments[0].payment_environment = 'PRODUCTION';
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-PROD' });
  const err = mock.method(console, 'error', () => {});
  let res;
  try {
    res = await call(() => w.status(statusEvent(w.bookingId)));
  } finally {
    err.mock.restore();
  }
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.statusCalls.length, 0, 'sandbox PhonePe is never asked about a PRODUCTION order');
  assert.equal(w.store.payments[0].payment_status, 'pending');
  assert.equal(w.store.bookings[0].status, 'pending');
  assert.equal(res.body.outcome, 'pending');
});

test('status: SANDBOX payments are still reconciled by the sandbox provider', async () => {
  const w = setup();
  const payment = await started(w);
  assert.equal(w.store.payments[0].payment_environment, 'SANDBOX');
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-SANDBOX' });
  const res = await call(() => w.status(statusEvent(w.bookingId)));
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(w.provider.statusCalls.length, 1);
});

test('status: a NULL/unknown payment environment is refused rather than reconciled (no provider call, no state change)', async () => {
  for (const env of [null, 'LIVE']) {
    const w = setup();
    const payment = await started(w);
    w.store.payments[0].payment_environment = env as never;
    w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-X' });
    const err = mock.method(console, 'error', () => {});
    let res;
    try {
      res = await call(() => w.status(statusEvent(w.bookingId)));
    } finally {
      err.mock.restore();
    }
    assert.equal(res.statusCode, 200, String(env));
    assert.equal(w.provider.statusCalls.length, 0, String(env));
    assert.equal(w.store.payments[0].payment_status, 'pending');
    assert.equal(w.store.bookings[0].status, 'pending');
    assert.equal(res.body.outcome, 'pending');
  }
});
