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
import { FakeReconcileQueue } from '../lib/test-support/fake-reconcile-queue';
import { ScriptedProvider } from '../lib/test-support/scripted-provider';
import { createHandler as createStartHandler } from './payment-start';
import { createHandler as createStatusHandler } from './payment-status';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const ME = 'sub-alice';
const OTHER = 'sub-bob';
const SECRET_SENTINEL = 'SUPER-SECRET-CLIENT-SECRET';
const PROD_QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/123456789012/playx-dev-payment-reconcile-production-fast';

afterEach(() => mock.timers.reset());

/** ScriptedProvider that behaves like the PhonePe adapter: knows its environment, hands back a
 *  phonepe.com checkout URL. */
class TestProvider extends ScriptedProvider {
  environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX';
  redirectUrlOverride?: string;
  reportedExpiry?: Date;
  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const result = await super.createPayment(request);
    return {
      ...result,
      ...(this.reportedExpiry ? { providerExpiresAt: this.reportedExpiry } : {}),
      redirectUrl: this.redirectUrlOverride ?? `https://mercury-uat.phonepe.com/checkout/${request.providerOrderId}`,
      raw: { clientSecret: SECRET_SENTINEL },
    };
  }
}

interface World {
  store: FakePaymentDbStore;
  provider: TestProvider;
  queue: FakeReconcileQueue;
  queueUrls: string[];
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
  const queue = new FakeReconcileQueue();
  const queueUrls: string[] = [];
  const env: NodeJS.ProcessEnv = {
    PAYMENT_START_ENABLED: 'true',
    PHONEPE_ENVIRONMENT: 'SANDBOX',
    PHONEPE_SANDBOX_TESTERS: ME,
    PAYMENT_RETURN_URL: 'https://staging.playxcafe.com/payment-return.html',
    ...envOverrides,
  };
  const deps = {
    getDb: async () => createFakePaymentDbClient(store),
    resetDb: () => {},
    getProvider: async () => provider,
    getReconcileQueue: (url: string) => {
      queueUrls.push(url);
      return queue;
    },
  };
  return {
    store,
    provider,
    queue,
    queueUrls,
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
  const ok = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION', PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL, PHONEPE_PRODUCTION_TESTERS: ME }, { bookingEnvironment: 'PRODUCTION' });
  ok.provider.environment = 'PRODUCTION';
  const res = await call(() => ok.start(startEvent({ bookingId: ok.bookingId, paymentEnvironment: 'SANDBOX', environment: 'SANDBOX' })));
  assert.equal(res.statusCode, 200);
  assert.equal(ok.store.payments[0].payment_environment, 'PRODUCTION');
  assert.equal(ok.store.payments[0].metadata?.paymentEnvironment, 'PRODUCTION');

  const err = mock.method(console, 'error', () => {});
  try {
    for (const bookingEnvironment of ['SANDBOX', null] as const) {
      const w = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION', PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL, PHONEPE_PRODUCTION_TESTERS: ME }, { bookingEnvironment });
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
  // Deploy config says PRODUCTION (the caller passes the production gate up front) but the secret
  // is a SANDBOX one: the SANDBOX gate still applies.
  const w = setup({ PHONEPE_ENVIRONMENT: 'PRODUCTION', PHONEPE_SANDBOX_TESTERS: '', PHONEPE_PRODUCTION_TESTERS: ME, PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL });
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
  const deps = { getDb: async () => createFakePaymentDbClient(w.store), resetDb: () => {}, env: w.env, getReconcileQueue: () => w.queue };
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

// ---------------------------------------------------------------- PAYMENT_START_ENABLED kill switch

/** Production-style deps (as PaymentStartProductionFunction is configured) whose every side-effect
 *  seam counts calls, so a disabled start can prove it touched nothing. */
function killSwitchWorld(paymentStartEnabled: string | undefined) {
  const w = setup(
    {
      PAYMENT_START_ENABLED: paymentStartEnabled,
      PHONEPE_ENVIRONMENT: 'PRODUCTION',
      PHONEPE_SECRET_NAME: 'playx/phonepe/production',
      PAYMENT_RETURN_URL: 'https://playxcafe.com/payment-return.html',
      PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL,
      PHONEPE_SANDBOX_TESTERS: undefined,
    },
    { bookingEnvironment: 'PRODUCTION' },
  );
  w.provider.environment = 'PRODUCTION';
  const calls = { getDb: 0, resetDb: 0, getProvider: 0, getReconcileQueue: 0 };
  const start = createStartHandler({
    env: w.env,
    getReconcileQueue: () => {
      calls.getReconcileQueue += 1;
      return w.queue;
    },
    getDb: async () => {
      calls.getDb += 1;
      return createFakePaymentDbClient(w.store);
    },
    resetDb: () => {
      calls.resetDb += 1;
    },
    getProvider: async () => {
      calls.getProvider += 1;
      return w.provider;
    },
  });
  return { ...w, start, calls };
}

test('kill switch: PAYMENT_START_ENABLED=false -> generic 503 before any DB, secret, provider or payment work', async () => {
  const w = killSwitchWorld('false');
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payments_temporarily_unavailable');
  assert.equal(w.calls.getProvider, 0, 'provider (and so the PhonePe secret/SDK) never loaded');
  assert.equal(w.calls.getDb, 0, 'no DB connection');
  assert.equal(w.calls.resetDb, 0);
  assert.equal(w.provider.createCalls.length, 0, 'startPayment never reached the provider');
  assert.equal(w.store.payments.length, 0, 'no payment row created');
  assert.equal(w.calls.getReconcileQueue, 0, 'no SQS client');
  assert.equal(w.queue.attempts, 0, 'nothing enqueued');
  assert.ok(!/SANDBOX|PRODUCTION|environment|phonepe|secret|playxcafe/i.test(res.raw), 'no environment/config detail exposed');
});

test('kill switch: missing / non-exact values are all disabled (fail closed)', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'enabled']) {
    const w = killSwitchWorld(value);
    const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
    assert.equal(res.statusCode, 503, JSON.stringify(value));
    assert.equal(res.body.error, 'payments_temporarily_unavailable');
    assert.equal(w.calls.getProvider + w.calls.getDb + w.calls.getReconcileQueue, 0, JSON.stringify(value));
    assert.equal(w.queue.attempts, 0);
    assert.equal(w.store.payments.length, 0);
  }
});

test('kill switch: disabled wins over everything else — even unauthenticated or malformed requests learn nothing more', async () => {
  const w = killSwitchWorld('false');
  for (const event of [startEvent({ bookingId: w.bookingId }, null), startEvent('{oops'), startEvent({ bookingId: w.bookingId, environment: 'SANDBOX', paymentStartEnabled: 'true' })]) {
    const res = await call(() => w.start(event));
    assert.equal(res.statusCode, 503);
  }
  assert.equal(w.calls.getProvider + w.calls.getDb, 0);
});

test('kill switch: PAYMENT_START_ENABLED=true keeps the existing sandbox happy path unchanged', async () => {
  const w = setup({ PAYMENT_START_ENABLED: 'true' });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1);
  assert.equal(w.store.payments[0].payment_environment, 'SANDBOX');
  assert.equal(w.queueUrls.length, 0, 'sandbox never builds the production queue client');
  assert.equal(w.queue.attempts, 0, 'sandbox never enqueues');
});

test('kill switch: the handler module never statically imports the PhonePe runtime/SDK', () => {
  const src = require('node:fs').readFileSync(require.resolve('./payment-start.ts'), 'utf8') as string;
  // `import type` is erased at compile time; only a value import would load the module eagerly.
  assert.doesNotMatch(src, /^import (?!type )[^;]*phonepe-runtime/m);
  assert.doesNotMatch(src, /^import (?!type )[^;]*@phonepe-pg/m);
  assert.match(src, /require\('\.\.\/lib\/phonepe-runtime'\)/, 'loaded lazily inside getProvider');
});

// ---------------------------------------------------------------- PRODUCTION fast reconciliation (Stage 2B)

/** PaymentStartProductionFunction-shaped world with the kill switch ON — as deployed from Stage 2D
 *  (PAYMENT_START_ENABLED=true), still behind the PHONEPE_PRODUCTION_TESTERS allowlist. */
function prodWorld(envOverrides: NodeJS.ProcessEnv = {}) {
  const w = setup(
    {
      PAYMENT_START_ENABLED: 'true',
      PHONEPE_ENVIRONMENT: 'PRODUCTION',
      PAYMENT_RETURN_URL: 'https://playxcafe.com/payment-return.html',
      PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL,
      PHONEPE_SANDBOX_TESTERS: undefined,
      // Stage 2C: the production tester allowlist (Cognito subs only).
      PHONEPE_PRODUCTION_TESTERS: ME,
      ...envOverrides,
    },
    { bookingEnvironment: 'PRODUCTION' },
  );
  w.provider.environment = 'PRODUCTION';
  return w;
}

async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const err = mock.method(console, 'error', () => {});
  try {
    return await fn();
  } finally {
    err.mock.restore();
  }
}

test('PRODUCTION start: missing/invalid queue URL fails closed (503) before DB, secret, PhonePe or SQS', async () => {
  for (const url of [undefined, '', '  ', 'queue', 'http://sqs.ap-south-1.amazonaws.com/1/q', ` ${PROD_QUEUE_URL}`]) {
    const w = prodWorld({ PAYMENT_RECONCILE_QUEUE_URL: url });
    const calls = { getDb: 0, getProvider: 0 };
    const start = createStartHandler({
      env: w.env,
      getDb: async () => { calls.getDb += 1; return createFakePaymentDbClient(w.store); },
      resetDb: () => {},
      getProvider: async () => { calls.getProvider += 1; return w.provider; },
      getReconcileQueue: () => w.queue,
    });
    const res = await quietly(() => call(() => start(startEvent({ bookingId: w.bookingId }))));
    assert.equal(res.statusCode, 503, JSON.stringify(url));
    assert.equal(res.body.error, 'payments_unavailable');
    assert.equal(calls.getDb + calls.getProvider, 0, JSON.stringify(url));
    assert.equal(w.provider.createCalls.length, 0);
    assert.equal(w.store.payments.length, 0);
    assert.equal(w.queue.attempts, 0);
    assert.ok(!/queue|sqs|PRODUCTION/i.test(res.raw), 'no config detail exposed');
  }
});

test('PRODUCTION secret behind a SANDBOX deploy config still needs the queue: refused before any PhonePe call', async () => {
  const w = setup({ PHONEPE_ENVIRONMENT: 'SANDBOX', PHONEPE_PRODUCTION_TESTERS: ME }, { bookingEnvironment: 'PRODUCTION' });
  w.provider.environment = 'PRODUCTION';
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 503);
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('PRODUCTION start: after the order is created AND persisted, the first check is enqueued 22s out with the local payment id', async () => {
  const w = prodWorld();
  let atSend: { status: string; redirect: unknown } | undefined;
  w.queue.onSend = () => {
    const row = w.store.payments[0];
    atSend = { status: row.payment_status, redirect: (row.metadata as { checkout?: { redirectUrl?: unknown } }).checkout?.redirectUrl };
  };
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1);
  const payment = w.store.payments[0];
  assert.deepEqual(w.queue.sent, [{ message: { paymentId: payment.id, seq: 1 }, delaySeconds: 22 }]);
  assert.deepEqual(w.queueUrls, [PROD_QUEUE_URL]);
  assert.deepEqual(atSend, { status: 'pending', redirect: res.body.redirectUrl }, 'enqueued only after TX2 persisted the order');
});

test('PRODUCTION start: provider failure -> nothing enqueued', async () => {
  const w = prodWorld();
  w.provider.createError = new PaymentProviderError('PhonePe create order failed (HTTP 400)', true, 400);
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 502);
  assert.equal(w.queue.attempts, 0);
});

test('PRODUCTION start: queue failure -> 503 with NO checkout redirect; the attempt is kept; a retry reuses it (no second PhonePe order) and schedules', async () => {
  const w = prodWorld();
  w.queue.sendError = new Error('AccessDenied: arn:aws:sqs:secret-ish');
  const failed = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'payments_unavailable');
  assert.equal(failed.body.redirectUrl, undefined);
  assert.ok(!failed.raw.includes('phonepe.com') && !failed.raw.includes('secret-ish'));
  assert.equal(w.provider.createCalls.length, 1);
  assert.equal(w.store.payments.length, 1);
  const payment = w.store.payments[0];
  assert.equal(payment.payment_status, 'pending', 'provider order + local state preserved');
  assert.equal((payment.metadata as { fastReconcileSeq?: number }).fastReconcileSeq, undefined, 'seq never advanced for an unsent link');

  w.queue.sendError = undefined;
  mock.timers.tick(4_000);
  const retried = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(retried.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1, 'never a duplicate provider order');
  assert.equal(w.store.payments.length, 1);
  assert.deepEqual(w.queue.sent, [{ message: { paymentId: payment.id, seq: 1 }, delaySeconds: 18 }], 'first check still lands at t=22');

  // A further start reuses the order and, since seq > 0 alone doesn't prove the chain is alive,
  // sends a recovery copy of the current link (still waiting for t=22) before redirecting.
  const again = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.redirectUrl, retried.body.redirectUrl);
  assert.deepEqual(w.queue.sent[1], { message: { paymentId: payment.id, seq: 1 }, delaySeconds: 18 });
  assert.equal((payment.metadata as { fastReconcileSeq?: number }).fastReconcileSeq, 1);
  assert.equal(w.provider.createCalls.length, 1);
});

/** A start handler for `w` whose DB client fails the fastReconcileSeq CAS (the write after a
 *  successful SendMessage). */
function startWithFailingSeqCas(w: World) {
  return createStartHandler({
    env: w.env,
    getDb: async () => {
      const db = createFakePaymentDbClient(w.store);
      return {
        ...db,
        query: async (text: string, params?: unknown[]) => {
          if (/'fastReconcileSeq'/.test(text)) throw new Error('connection terminated');
          return db.query(text, params);
        },
      } as typeof db;
    },
    resetDb: () => {},
    getProvider: async () => w.provider,
    getReconcileQueue: () => w.queue,
  });
}

const seqOf = (w: World) => (w.store.payments[0].metadata as { fastReconcileSeq?: number }).fastReconcileSeq;

test('PRODUCTION start: seq 1 sent but its advance not recorded (DB failure) -> 503, no redirect; the retry reuses the order and its duplicate seq 1 is recorded', async () => {
  const w = prodWorld();
  const failed = await quietly(() => call(() => startWithFailingSeqCas(w)(startEvent({ bookingId: w.bookingId }))));
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'payments_unavailable');
  assert.equal(failed.body.redirectUrl, undefined);
  assert.equal(seqOf(w), undefined);
  assert.deepEqual(w.queue.sent.map((s) => s.message.seq), [1], 'the message itself is out (and would self-activate)');

  const retried = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(retried.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1, 'no duplicate PhonePe order');
  assert.deepEqual(w.queue.sent.map((s) => s.message.seq), [1, 1], 'a harmless same-seq duplicate');
  assert.equal(seqOf(w), 1);
});

test('PRODUCTION start: ambiguous SQS failure (enqueued, then threw) -> 503, seq stays 0; retry reuses the order and sends seq 1 again', async () => {
  const w = prodWorld();
  w.queue.ambiguousError = new Error('TimeoutError');
  const failed = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.redirectUrl, undefined);
  assert.ok(!/queue|sqs|PRODUCTION|Timeout/i.test(failed.raw), 'no queue detail exposed');
  assert.equal(seqOf(w), undefined);

  w.queue.ambiguousError = undefined;
  const retried = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(retried.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1);
  assert.deepEqual(w.queue.sent.map((s) => s.message.seq), [1, 1]);
  assert.equal(seqOf(w), 1);
});

test('PRODUCTION start: ensure result fast_window_ended -> generic 503, no redirect, nothing enqueued', async () => {
  const w = prodWorld();
  w.provider.reportedExpiry = new Date(T0); // the provider says the order has already expired
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payments_unavailable');
  assert.equal(res.body.redirectUrl, undefined);
  assert.ok(!/queue|sqs|PRODUCTION|window/i.test(res.raw));
  assert.equal(w.queue.attempts, 0);
});

test('PRODUCTION start: ensure result not_open -> generic 503, no redirect, nothing enqueued', async () => {
  const w = prodWorld();
  const start = createStartHandler({
    env: w.env,
    getDb: async () => createFakePaymentDbClient(w.store),
    resetDb: () => {},
    getProvider: async () => w.provider,
    // The attempt closes (e.g. a webhook failed it) between startPayment() and scheduling.
    getReconcileQueue: () => {
      w.store.payments[0].payment_status = 'failed';
      return w.queue;
    },
  });
  const res = await quietly(() => call(() => start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payments_unavailable');
  assert.equal(res.body.redirectUrl, undefined);
  assert.equal(w.queue.attempts, 0);
});

/** A PRODUCTION attempt started successfully, whose chain then reached seq 4 and whose live link
 *  was lost (dead-lettered): row seq 4, nothing in the queue. The clock is at t=60s. */
async function deadChainAtSeq4(w: World) {
  const first = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(first.statusCode, 200);
  const row = w.store.payments[0];
  row.metadata = { ...(row.metadata ?? {}), fastReconcileSeq: 4 };
  w.queue.sent = [];
  mock.timers.tick(60_000);
  return { first, row };
}

test('PRODUCTION start, dead chain (seq 4, no live message): reuses the order, sends { seq: 4 } with delay 0, and only then redirects', async () => {
  const w = prodWorld();
  const { first, row } = await deadChainAtSeq4(w);
  let redirectPersistedAtSend: unknown;
  w.queue.onSend = () => { redirectPersistedAtSend = (row.metadata as { checkout?: { redirectUrl?: unknown } }).checkout?.redirectUrl; };
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.redirectUrl, first.body.redirectUrl, 'the same PhonePe order');
  assert.equal(redirectPersistedAtSend, first.body.redirectUrl);
  assert.equal(w.provider.createCalls.length, 1, 'no duplicate provider order');
  assert.equal(w.store.payments.length, 1);
  assert.deepEqual(w.queue.sent, [{ message: { paymentId: row.id, seq: 4 }, delaySeconds: 0 }]);
  assert.equal(seqOf(w), 4, 'recovery never moves the seq');
});

test('PRODUCTION start, recovery send failure -> generic 503, no redirect, seq stays 4, same order; a retry recovers', async () => {
  const w = prodWorld();
  const { row } = await deadChainAtSeq4(w);
  const orderId = row.provider_order_id;
  w.queue.sendError = new Error('AccessDenied: arn:aws:sqs:secret-ish');
  const failed = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.error, 'payments_unavailable');
  assert.equal(failed.body.redirectUrl, undefined);
  assert.ok(!/queue|sqs|secret-ish|PRODUCTION/i.test(failed.raw));
  assert.equal(seqOf(w), 4);
  assert.equal(w.store.payments[0].provider_order_id, orderId);
  assert.equal(w.provider.createCalls.length, 1);

  w.queue.sendError = undefined;
  const retried = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(w.queue.sent.map((x) => [x.message.seq, x.delaySeconds]), [[4, 0]]);
  assert.equal(w.provider.createCalls.length, 1);
});

test('PRODUCTION start, ambiguous recovery send (enqueued, then threw) -> 503, seq stays 4; a retry sends another seq 4 (a harmless same-seq duplicate)', async () => {
  const w = prodWorld();
  await deadChainAtSeq4(w);
  w.queue.ambiguousError = new Error('TimeoutError');
  const failed = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.redirectUrl, undefined);
  assert.equal(seqOf(w), 4);
  assert.deepEqual(w.queue.sent.map((x) => x.message.seq), [4], 'the copy is out anyway');

  w.queue.ambiguousError = undefined;
  const retried = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(retried.statusCode, 200);
  assert.deepEqual(w.queue.sent.map((x) => x.message.seq), [4, 4]);
  assert.equal(seqOf(w), 4);
  assert.equal(w.provider.createCalls.length, 1);
});

test('PRODUCTION start on a started chain whose fast window has ended -> generic 503, no redirect, no recovery sent', async () => {
  const w = prodWorld();
  const { row } = await deadChainAtSeq4(w);
  // PhonePe's own expiry for the order has been reached (our requested expiry hasn't), so
  // startPayment still reuses the attempt but the fast window is over.
  row.metadata = { ...(row.metadata ?? {}), providerExpiresAt: new Date(Date.now()).toISOString() };
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payments_unavailable');
  assert.equal(res.body.redirectUrl, undefined);
  assert.equal(w.provider.createCalls.length, 1, 'the attempt was reused, not replaced');
  assert.equal(w.queue.sent.length, 0, 'no recovery sent');
  assert.equal(seqOf(w), 4);
});

test('PRODUCTION start with the kill switch off: 503 before DB/provider/SQS even with a queue configured', async () => {
  const w = prodWorld({ PAYMENT_START_ENABLED: 'false' });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'payments_temporarily_unavailable');
  assert.equal(w.queueUrls.length, 0);
  assert.equal(w.queue.attempts, 0);
  assert.equal(w.store.payments.length, 0);
});

test('SANDBOX start never requires or touches the production queue (even if a URL were present)', async () => {
  const w = setup({ PAYMENT_RECONCILE_QUEUE_URL: PROD_QUEUE_URL });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.equal(w.queueUrls.length, 0);
  assert.equal(w.queue.attempts, 0);
  assert.equal((w.store.payments[0].metadata as { fastReconcileSeq?: number }).fastReconcileSeq, undefined);
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

// ---------------------------------------------------------------- Stage 2C: PRODUCTION tester gate (payment start)

test('PRODUCTION start tester gate: kill switch off -> 503 before the gate, DB or provider, for listed and unlisted subs alike', async () => {
  for (const sub of [ME, OTHER]) {
    const w = prodWorld({ PAYMENT_START_ENABLED: 'false' });
    const calls = { getDb: 0, getProvider: 0 };
    const start = createStartHandler({
      env: w.env,
      getDb: async () => { calls.getDb += 1; return createFakePaymentDbClient(w.store); },
      resetDb: () => {},
      getProvider: async () => { calls.getProvider += 1; return w.provider; },
      getReconcileQueue: () => w.queue,
    });
    const res = await call(() => start(startEvent({ bookingId: w.bookingId }, { sub })));
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'payments_temporarily_unavailable');
    assert.equal(calls.getDb + calls.getProvider, 0);
  }
});

test('PRODUCTION start tester gate: switch on + missing/empty tester list -> 403 for everyone, before DB/provider/SQS', async () => {
  for (const testers of [undefined, '', '  ', ' , ,']) {
    const w = prodWorld({ PHONEPE_PRODUCTION_TESTERS: testers });
    const calls = { getDb: 0, getProvider: 0 };
    const start = createStartHandler({
      env: w.env,
      getDb: async () => { calls.getDb += 1; return createFakePaymentDbClient(w.store); },
      resetDb: () => {},
      getProvider: async () => { calls.getProvider += 1; return w.provider; },
      getReconcileQueue: () => w.queue,
    });
    const res = await call(() => start(startEvent({ bookingId: w.bookingId })));
    assert.equal(res.statusCode, 403, JSON.stringify(testers));
    assert.equal(res.body.error, 'payments_not_permitted');
    assert.equal(calls.getDb + calls.getProvider, 0);
    assert.equal(w.queue.attempts, 0);
    assert.equal(w.store.payments.length, 0);
  }
});

test('PRODUCTION start tester gate: switch on + non-allowlisted sub -> 403 (same body as the sandbox gate), even with a verified email or a body claim', async () => {
  const w = prodWorld({ PHONEPE_PRODUCTION_TESTERS: 'sub-someone-else, tester@example.com' });
  const claims = { sub: ME, email: 'tester@example.com', email_verified: 'true' };
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId, sub: 'sub-someone-else', testers: ME }, claims)));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: 'payments_not_permitted', message: 'Payments are not available for this account' });
  assert.ok(!/PRODUCTION|tester|allowlist/i.test(res.raw));
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('PRODUCTION start tester gate: switch on + allowlisted sub -> reaches the normal payment logic (order + fast chain)', async () => {
  const w = prodWorld({ PHONEPE_PRODUCTION_TESTERS: `sub-x, ${ME} ,sub-y` });
  const res = await call(() => w.start(startEvent({ bookingId: w.bookingId })));
  assert.equal(res.statusCode, 200);
  assert.equal(w.provider.createCalls.length, 1);
  assert.equal(w.store.payments[0].payment_environment, 'PRODUCTION');
  assert.deepEqual(w.queue.sent.map((x) => x.message.seq), [1]);
  // ...and the ownership check still applies to an allowlisted tester.
  const other = prodWorld({ PHONEPE_PRODUCTION_TESTERS: `${ME},${OTHER}` });
  assert.equal((await call(() => other.start(startEvent({ bookingId: other.bookingId }, { sub: OTHER })))).statusCode, 404);
});

test('Stage 2D: switch on + allowlisted sub -> PRODUCTION provider only (production return URL), PRODUCTION queue only, PRODUCTION rows only', async () => {
  const w = prodWorld();
  const returnUrls: (string | undefined)[] = [];
  const start = createStartHandler({
    env: w.env,
    getDb: async () => createFakePaymentDbClient(w.store),
    resetDb: () => {},
    getProvider: async (returnUrl) => { returnUrls.push(returnUrl); return w.provider; },
    getReconcileQueue: (url) => { w.queueUrls.push(url); return w.queue; },
  });
  // A body trying to steer the environment, amount or return URL changes nothing.
  const body = { bookingId: w.bookingId, environment: 'SANDBOX', amount: 1, amountPaise: 100, returnUrl: 'https://evil.example/' };
  const res = await call(() => start(startEvent(body)));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(returnUrls, ['https://playxcafe.com/payment-return.html']);
  assert.equal(w.provider.createCalls.length, 1);
  assert.equal(w.provider.createCalls[0].amountInr, '999.00', 'amount from bookings.price_inr, never the request');
  assert.match(w.provider.createCalls[0].returnUrl ?? '', /^https:\/\/playxcafe\.com\/payment-return\.html\?bookingId=/);
  assert.equal(w.store.payments.length, 1);
  assert.equal(w.store.payments[0].payment_environment, 'PRODUCTION');
  assert.deepEqual(w.queueUrls, [PROD_QUEUE_URL], 'the production fast-reconcile queue and nothing else');
});

test('Stage 2D: switch on + allowlisted sub, but the provider is NOT PRODUCTION -> refused, no order, nothing enqueued', async () => {
  const w = prodWorld();
  w.provider.environment = 'SANDBOX';
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 403, 'a sandbox provider re-gates on the (empty) sandbox list');
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
  assert.equal(w.queue.attempts, 0);
});

test('PRODUCTION start tester gate: a PRODUCTION secret behind a SANDBOX deploy config is re-gated on the production list', async () => {
  const w = setup({ PHONEPE_ENVIRONMENT: 'SANDBOX', PHONEPE_SANDBOX_TESTERS: ME, PHONEPE_PRODUCTION_TESTERS: undefined }, { bookingEnvironment: 'PRODUCTION' });
  w.provider.environment = 'PRODUCTION';
  const res = await quietly(() => call(() => w.start(startEvent({ bookingId: w.bookingId }))));
  assert.equal(res.statusCode, 403);
  assert.equal(w.provider.createCalls.length, 0);
  assert.equal(w.store.payments.length, 0);
});

test('SANDBOX start: the production tester list plays no part (sandbox gate unchanged)', async () => {
  const onlyProd = setup({ PHONEPE_SANDBOX_TESTERS: '', PHONEPE_PRODUCTION_TESTERS: ME });
  assert.equal((await call(() => onlyProd.start(startEvent({ bookingId: onlyProd.bookingId })))).statusCode, 403, 'a production tester is not a sandbox tester');
  const both = setup({ PHONEPE_SANDBOX_TESTERS: ME, PHONEPE_PRODUCTION_TESTERS: '' });
  assert.equal((await call(() => both.start(startEvent({ bookingId: both.bookingId })))).statusCode, 200, 'an empty production list does not affect sandbox');
});

// ---------------------------------------------------------------- Stage 2C: GET /payments/production/{bookingId}/status

/** A started PRODUCTION attempt plus the PRODUCTION status handler (payment-status-production.ts's
 *  configuration) over the same store and provider. */
async function prodStatusWorld() {
  const w = prodWorld();
  const payment = await started(w);
  const prodStatus = createStatusHandler(
    { getDb: async () => createFakePaymentDbClient(w.store), resetDb: () => {}, getProvider: async () => w.provider },
    { environment: 'PRODUCTION' },
  );
  return { w, payment, prodStatus };
}

test('production status: the entry file hard-codes PRODUCTION on the shared payment-status implementation', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./payment-status-production.ts'), 'utf8') as string;
  assert.match(src, /^export const handler = createHandler\(defaultDeps, \{ environment: 'PRODUCTION' \}\);$/m);
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /event|process\.env|SANDBOX/, 'nothing request- or env-derived chooses the environment');
});

test('production status: no JWT -> 401; malformed id -> 400; another customer -> 404', async () => {
  const { w, prodStatus } = await prodStatusWorld();
  assert.equal((await call(() => prodStatus(statusEvent(w.bookingId, null)))).statusCode, 401);
  assert.equal((await call(() => prodStatus(statusEvent('nope')))).statusCode, 400);
  assert.equal((await call(() => prodStatus(statusEvent(w.bookingId, { sub: OTHER })))).statusCode, 404);
  assert.equal(w.provider.statusCalls.length, 0);
});

test('production status: a PRODUCTION attempt is reconciled with the PRODUCTION provider and confirmed', async () => {
  const { w, payment, prodStatus } = await prodStatusWorld();
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'PENDING' });
  const pending = await call(() => prodStatus(statusEvent(w.bookingId)));
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.body.outcome, 'pending');
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-PROD-1' });
  const res = await call(() => prodStatus(statusEvent(w.bookingId)));
  assert.deepEqual(Object.keys(res.body).sort(), ['bookingId', 'bookingNumber', 'bookingStatus', 'canRetry', 'holdExpiresAt', 'outcome', 'paymentStatus']);
  assert.equal(res.body.outcome, 'confirmed');
  assert.equal(res.body.bookingStatus, 'confirmed');
  assert.deepEqual(w.provider.statusCalls, [payment.provider_order_id, payment.provider_order_id]);
  assert.ok(!/TX-PROD-1|PRODUCTION/.test(res.raw));
});

test('production status: a SANDBOX booking cannot be read through the production route (404, no provider call, nothing leaked)', async () => {
  const w = setup();
  const payment = await started(w); // a SANDBOX booking with a SANDBOX attempt
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-SB' });
  const prodStatus = createStatusHandler(
    { getDb: async () => createFakePaymentDbClient(w.store), resetDb: () => {}, getProvider: async () => w.provider },
    { environment: 'PRODUCTION' },
  );
  const res = await call(() => prodStatus(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'booking_not_found', message: 'Booking not found' });
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.store.payments[0].payment_status, 'pending');
  // NULL/unknown booking environments are not PRODUCTION either.
  for (const env of [null, 'LIVE']) {
    w.store.bookings[0].booking_environment = env as never;
    assert.equal((await call(() => prodStatus(statusEvent(w.bookingId)))).statusCode, 404, String(env));
  }
});

test('production status: SANDBOX payment rows on a PRODUCTION booking are neither reconciled nor reported', async () => {
  const { w, payment, prodStatus } = await prodStatusWorld();
  // Relabel the only attempt as SANDBOX (and paid) — the production route must behave as if it isn't there.
  w.store.payments[0].payment_environment = 'SANDBOX';
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-SB' });
  const res = await call(() => prodStatus(statusEvent(w.bookingId)));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.paymentStatus, null, 'the SANDBOX row is not reported');
  assert.equal(w.provider.statusCalls.length, 0, 'and never reconciled');
  assert.equal(w.store.payments[0].payment_status, 'pending');
  w.store.payments[0].payment_status = 'paid';
  const paidElsewhere = await call(() => prodStatus(statusEvent(w.bookingId)));
  assert.equal(paidElsewhere.body.paymentStatus, null);
  assert.notEqual(paidElsewhere.body.outcome, 'confirmed');
});

test('production status: a provider that is not PRODUCTION never reconciles a PRODUCTION attempt', async () => {
  const { w, payment, prodStatus } = await prodStatusWorld();
  w.provider.environment = 'SANDBOX';
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX' });
  const res = await quietly(() => call(() => prodStatus(statusEvent(w.bookingId))));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'pending');
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.store.payments[0].payment_status, 'pending');
});

test('sandbox status route is unchanged: still reports (without reconciling) a PRODUCTION booking, as before Stage 2C', async () => {
  const { w, payment } = await prodStatusWorld();
  w.provider.statuses.set(payment.provider_order_id, { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX' });
  w.provider.environment = 'SANDBOX'; // the sandbox Lambda's provider
  const res = await quietly(() => call(() => w.status(statusEvent(w.bookingId))));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.outcome, 'pending');
  assert.equal(w.provider.statusCalls.length, 0);
});
