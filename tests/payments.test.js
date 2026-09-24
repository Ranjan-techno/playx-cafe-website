// Run with: node --test tests/
// Covers js/payments.js - the DOM-free core of the Phase 4 customer payment flow.
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../js/payments.js');

const BOOKING_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const OTHER_ID = '9a8b7c6d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const REDIRECT = 'https://mercury-uat.phonepe.com/transact/uat_v2?token=SECRET_REDIRECT_TOKEN';
const JWT = 'header.payload.SECRET_JWT';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
    dump: () => data
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makeClient({ fetchImpl, token = JWT, storage = memoryStorage() } = {}) {
  const redirects = [];
  const calls = [];
  const client = P.createPaymentClient({
    apiBaseUrl: 'https://api.test',
    getToken: async () => token,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return fetchImpl(url, init); },
    storage,
    redirect: (u) => redirects.push(u)
  });
  return { client, redirects, calls, storage };
}

const startOk = () => jsonResponse(200, {
  bookingId: BOOKING_ID, bookingNumber: 1042, paymentStatus: 'pending', redirectUrl: REDIRECT, expiresAt: '2026-09-25T10:00:00.000Z'
});

// ---- payment start ------------------------------------------------------------------------
test('start success: POSTs only bookingId with the Bearer token, stores context, redirects once', async () => {
  const { client, redirects, calls, storage } = makeClient({ fetchImpl: startOk });
  const result = await client.startPayment(BOOKING_ID);

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.test/payments/start');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${JWT}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { bookingId: BOOKING_ID }); // no amount, no status
  assert.deepEqual(redirects, [REDIRECT]);
  assert.equal(P.readCheckoutContext(storage).bookingId, BOOKING_ID);
});

test('stored checkout context holds no token, redirect URL or amount', async () => {
  const { client, storage } = makeClient({ fetchImpl: startOk });
  await client.startPayment(BOOKING_ID);
  const stored = JSON.stringify(storage.dump());
  assert.ok(!stored.includes('SECRET_JWT'));
  assert.ok(!stored.includes('SECRET_REDIRECT_TOKEN'));
  assert.ok(!stored.includes('phonepe.com'));
});

test('double-click protection: a second start while one is in flight makes no second request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { client, redirects, calls } = makeClient({ fetchImpl: async () => { await gate; return startOk(); } });

  const first = client.startPayment(BOOKING_ID);
  const second = await client.startPayment(BOOKING_ID);
  assert.equal(second.ok, false);
  assert.equal(second.kind, 'busy');
  release();
  assert.deepEqual(await first, { ok: true });

  assert.equal(calls.length, 1);
  assert.equal(redirects.length, 1);
  // After a successful redirect the guard stays set: the page is leaving.
  assert.equal((await client.startPayment(BOOKING_ID)).kind, 'busy');
  assert.equal(calls.length, 1);
});

test('after a failed start the guard is released so the customer can retry', async () => {
  let n = 0;
  const { client, calls } = makeClient({ fetchImpl: () => (++n === 1 ? jsonResponse(503, {}) : startOk()) });
  assert.equal((await client.startPayment(BOOKING_ID)).kind, 'provider_unavailable');
  assert.deepEqual(await client.startPayment(BOOKING_ID), { ok: true });
  assert.equal(calls.length, 2);
});

// ---- redirect handling --------------------------------------------------------------------
test('redirect handling: only https phonepe.com hosts are ever navigated to', () => {
  assert.equal(P.isSafeCheckoutRedirect('https://mercury-uat.phonepe.com/x'), true);
  assert.equal(P.isSafeCheckoutRedirect('https://phonepe.com/x'), true);
  assert.equal(P.isSafeCheckoutRedirect('http://mercury.phonepe.com/x'), false);
  assert.equal(P.isSafeCheckoutRedirect('https://phonepe.com.evil.example/x'), false);
  assert.equal(P.isSafeCheckoutRedirect('https://evilphonepe.com/x'), false);
  assert.equal(P.isSafeCheckoutRedirect('javascript:alert(1)'), false);
  assert.equal(P.isSafeCheckoutRedirect('not a url'), false);
});

test('a start response with an unsafe redirect URL is rejected without navigating', async () => {
  const { client, redirects, storage } = makeClient({
    fetchImpl: () => jsonResponse(200, { redirectUrl: 'https://evil.example/pay' })
  });
  const result = await client.startPayment(BOOKING_ID);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'provider_rejected');
  assert.deepEqual(redirects, []);
  assert.equal(P.readCheckoutContext(storage), null);
});

test('return page ignores success=true style parameters and resolves only the booking id', () => {
  const storage = memoryStorage();
  assert.equal(P.resolveBookingId(`?bookingId=${BOOKING_ID.toUpperCase()}&success=true&code=PAYMENT_SUCCESS`, storage), BOOKING_ID);
  assert.equal(P.resolveBookingId('?success=true&code=PAYMENT_SUCCESS', storage), null);
  assert.equal(P.resolveBookingId('?bookingId=not-a-uuid', storage), null);
  P.saveCheckoutContext(storage, OTHER_ID);
  assert.equal(P.resolveBookingId('?success=true', storage), OTHER_ID); // falls back to stored context
  assert.equal(P.resolveBookingId(`?bookingId=${BOOKING_ID}`, storage), BOOKING_ID);
});

// ---- status -> view ------------------------------------------------------------------------
const statusOf = (over) => ({
  bookingId: BOOKING_ID, bookingNumber: 1042, bookingStatus: 'pending', paymentStatus: null,
  outcome: 'pending', holdExpiresAt: null, canRetry: false, ...over
});

test('payment success display: paid + confirmed booking', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'confirmed', bookingStatus: 'confirmed', paymentStatus: 'paid' }));
  assert.equal(v.state, 'success');
  assert.equal(v.title, 'Payment Successful');
  assert.equal(v.bookingLabel, 'Booking #1042');
  assert.equal(v.message, 'Your race is confirmed.');
  assert.equal(v.action, null);
});

test('"confirmed" outcome without a confirmed booking is never shown as success', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'confirmed', bookingStatus: 'pending' }));
  assert.notEqual(v.state, 'success');
});

test('pending state: processing copy and CHECK PAYMENT STATUS action', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'pending', paymentStatus: 'pending' }));
  assert.equal(v.state, 'pending');
  assert.equal(v.title, 'Payment Processing');
  assert.equal(v.message, "We're confirming your payment with PhonePe.");
  assert.equal(v.action, 'check');
  assert.equal(v.terminal, false);
});

test('unknown outcomes fall back to processing, never success or failure', () => {
  assert.equal(P.describePaymentStatus(statusOf({ outcome: 'something_new' })).state, 'pending');
  assert.equal(P.describePaymentStatus(null).state, 'pending');
});

test('failed state with retry allowed offers TRY PAYMENT AGAIN', () => {
  for (const outcome of ['failed', 'expired']) {
    const v = P.describePaymentStatus(statusOf({ outcome, paymentStatus: outcome, canRetry: true }));
    assert.equal(v.state, 'failed');
    assert.equal(v.title, 'Payment Not Completed');
    assert.equal(v.action, 'retry');
  }
});

test('failed state without retry offers no retry', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'failed', canRetry: false }));
  assert.equal(v.state, 'failed_final');
  assert.equal(v.action, null);
});

test('expired hold: explains the reservation expired and a new booking is needed', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'hold_expired' }));
  assert.equal(v.state, 'hold_expired');
  assert.match(v.message, /expired/i);
  assert.match(v.detail, /new booking/i);
  assert.equal(v.action, null);
});

test('refund-required / manual-review: safe copy, never claims a refund happened', () => {
  const v = P.describePaymentStatus(statusOf({ outcome: 'refund_required', paymentStatus: 'paid' }));
  assert.equal(v.state, 'manual_review');
  assert.equal(v.message, 'Payment received, but we could not confirm the booking.');
  assert.equal(v.detail, 'Please contact Play X Cafe support. Your payment will be reviewed.');
  assert.equal(v.action, null);
  assert.ok(!/refund(ed)?\b.*(complete|processed|issued)|has been refunded/i.test(`${v.message} ${v.detail}`));
});

test('My Bookings actions: Pay Now / Processing / Failed-Retry / expired / manual review', () => {
  assert.deepEqual(
    P.describeBookingPaymentAction(statusOf({ outcome: 'not_started', canRetry: true })),
    { label: 'Pay Now', action: 'pay', note: '' }
  );
  assert.equal(P.describeBookingPaymentAction(statusOf({ outcome: 'pending' })).label, 'Payment Processing');
  const failed = P.describeBookingPaymentAction(statusOf({ outcome: 'failed', canRetry: true }));
  assert.equal(failed.label, 'Payment Failed – Retry');
  assert.equal(failed.action, 'retry');
  const expired = P.describeBookingPaymentAction(statusOf({ outcome: 'hold_expired' }));
  assert.equal(expired.action, null);
  assert.match(expired.note, /expired/i);
  const review = P.describeBookingPaymentAction(statusOf({ outcome: 'refund_required' }));
  assert.equal(review.action, null);
  assert.match(review.note, /contact Play X Cafe support/);
});

// ---- API failures ---------------------------------------------------------------------------
const FAILURES = [
  [401, { error: 'unauthenticated' }, 'session_expired'],
  [403, { error: 'payments_not_permitted' }, 'not_permitted'],
  [404, { error: 'booking_not_found' }, 'not_found'],
  [409, { error: 'hold_expired' }, 'hold_expired'],
  [409, { error: 'booking_already_paid' }, 'already_paid'],
  [409, { error: 'booking_not_payable' }, 'not_payable'],
  [409, { error: 'payment_start_in_progress' }, 'in_progress'],
  [409, { error: 'capacity_unavailable' }, 'capacity_unavailable'],
  [409, { error: 'checkout_window_closed' }, 'checkout_window_closed'],
  [502, { error: 'payment_provider_error' }, 'provider_rejected'],
  [503, { error: 'payment_provider_unavailable' }, 'provider_unavailable'],
  [500, { error: 'internal_error' }, 'unknown']
];

for (const [status, body, kind] of FAILURES) {
  test(`API failure ${status} ${body.error} -> ${kind}; no redirect`, async () => {
    const { client, redirects } = makeClient({ fetchImpl: () => jsonResponse(status, body) });
    const result = await client.startPayment(BOOKING_ID);
    assert.equal(result.ok, false);
    assert.equal(result.kind, kind);
    assert.equal(result.message, P.ERROR_COPY[kind]);
    assert.deepEqual(redirects, []);
  });
}

test('raw backend/provider text in an error body is never surfaced', async () => {
  const leaky = { error: 'payment_provider_error', message: 'PhonePe said: client_secret=abc123 stack at pg.query' };
  const { client } = makeClient({ fetchImpl: () => jsonResponse(502, leaky) });
  const result = await client.startPayment(BOOKING_ID);
  assert.ok(!result.message.includes('abc123'));
  assert.ok(!/stack|pg\.|client_secret|PhonePe said/.test(result.message));
});

test('network failure is reported safely and re-arms the guard', async () => {
  let n = 0;
  const { client } = makeClient({ fetchImpl: () => { if (++n === 1) throw new Error('boom SECRET_JWT'); return startOk(); } });
  const result = await client.startPayment(BOOKING_ID);
  assert.equal(result.kind, 'network');
  assert.ok(!result.message.includes('SECRET_JWT'));
  assert.deepEqual(await client.startPayment(BOOKING_ID), { ok: true });
});

test('status fetch: success returns the backend payload; 404/503 map to safe errors', async () => {
  const payload = statusOf({ outcome: 'confirmed', bookingStatus: 'confirmed' });
  const ok = makeClient({ fetchImpl: () => jsonResponse(200, payload) });
  const res = await ok.client.getPaymentStatus(BOOKING_ID);
  assert.equal(res.ok, true);
  assert.deepEqual(res.status, payload);
  assert.equal(ok.calls[0].url, `https://api.test/payments/${BOOKING_ID}/status`);
  assert.equal(ok.calls[0].init.method, 'GET');

  assert.equal((await makeClient({ fetchImpl: () => jsonResponse(404, {}) }).client.getPaymentStatus(BOOKING_ID)).kind, 'not_found');
  assert.equal((await makeClient({ fetchImpl: () => jsonResponse(503, {}) }).client.getPaymentStatus(BOOKING_ID)).kind, 'provider_unavailable');
});

test('invalid booking ids never reach the network', async () => {
  const { client, calls } = makeClient({ fetchImpl: startOk });
  assert.equal((await client.startPayment('../../admin')).kind, 'not_found');
  assert.equal((await client.getPaymentStatus('nope')).kind, 'not_found');
  assert.equal(calls.length, 0);
});

// ---- session expiry --------------------------------------------------------------------------
test('session expiry: no token means no request and a log-in-again message', async () => {
  const { client, calls, redirects } = makeClient({ fetchImpl: startOk, token: null });
  const start = await client.startPayment(BOOKING_ID);
  const status = await client.getPaymentStatus(BOOKING_ID);
  assert.equal(start.kind, 'session_expired');
  assert.equal(status.kind, 'session_expired');
  assert.match(start.message, /session has expired/i);
  assert.equal(calls.length, 0);
  assert.deepEqual(redirects, []);
});

test('session expiry: a 401 from the API is reported as session expired', async () => {
  const { client } = makeClient({ fetchImpl: () => jsonResponse(401, { message: 'Unauthorized' }) });
  assert.equal((await client.getPaymentStatus(BOOKING_ID)).kind, 'session_expired');
});

// ---- review corrections: unknown status, in-progress, gate, token, stale context -----------
test('status API unavailable never produces Pay Now; it offers CHECK AGAIN', async () => {
  for (const status of [503, 500, 502]) {
    const { client } = makeClient({ fetchImpl: () => jsonResponse(status, {}) });
    const result = await client.getPaymentStatus(BOOKING_ID);
    assert.equal(result.ok, false);
    const action = P.describeStatusFailure(result);
    assert.equal(action.action, 'check');
    assert.equal(action.label, 'CHECK AGAIN');
    assert.equal(action.note, 'Unable to verify payment status.');
    assert.notEqual(action.action, 'pay');
    assert.doesNotMatch(action.label, /pay now/i);
  }
  const { client } = makeClient({ fetchImpl: () => { throw new Error('offline'); } });
  const action = P.describeStatusFailure(await client.getPaymentStatus(BOOKING_ID));
  assert.equal(action.action, 'check');
});

test('status failure: session_expired and not_found show a message and no payment action', () => {
  const expired = P.describeStatusFailure({ ok: false, kind: 'session_expired' });
  assert.equal(expired.action, null);
  assert.equal(expired.label, '');
  assert.equal(expired.note, P.ERROR_COPY.session_expired);
  const missing = P.describeStatusFailure({ ok: false, kind: 'not_found' });
  assert.equal(missing.action, null);
  assert.equal(missing.note, P.ERROR_COPY.not_found);
});

test('payment_start_in_progress becomes a status-check action, not Pay/Retry', async () => {
  const { client } = makeClient({ fetchImpl: () => jsonResponse(409, { error: 'payment_start_in_progress' }) });
  const result = await client.startPayment(BOOKING_ID);
  assert.equal(result.kind, 'in_progress');
  const action = P.describeStartInProgress();
  assert.equal(action.action, 'check');
  assert.equal(action.label, 'CHECK PAYMENT STATUS');
  assert.equal(action.note, 'Payment Processing');
});

test('getToken rejection: no network request and a safe session_expired result', async () => {
  const calls = [];
  const logged = [];
  const origLog = console.log; const origErr = console.error;
  console.log = (...a) => logged.push(a); console.error = (...a) => logged.push(a);
  try {
    const client = P.createPaymentClient({
      apiBaseUrl: 'https://api.test',
      getToken: async () => { throw new Error('token SECRET_JWT exploded'); },
      fetchImpl: async (...a) => { calls.push(a); return jsonResponse(200, {}); },
      storage: memoryStorage(),
      redirect: () => {}
    });
    const started = await client.startPayment(BOOKING_ID);
    const status = await client.getPaymentStatus(BOOKING_ID);
    assert.equal(started.kind, 'session_expired');
    assert.equal(status.kind, 'session_expired');
  } finally { console.log = origLog; console.error = origErr; }
  assert.equal(calls.length, 0);
  assert.equal(logged.length, 0);
});

test('payment UI: enabled on staging/localhost (SANDBOX) and playxcafe.com (PRODUCTION) only', () => {
  assert.equal(P.isPaymentUiEnabled('staging.playxcafe.com'), true);
  assert.equal(P.isPaymentUiEnabled('localhost'), true);
  assert.equal(P.isPaymentUiEnabled('127.0.0.1'), true);
  // Production cutover: the production site shows the payment UI; the backend's production
  // tester allowlist (not this list) decides who can actually use it.
  assert.equal(P.isPaymentUiEnabled('playxcafe.com'), true);
  assert.equal(P.isPaymentUiEnabled('www.playxcafe.com'), true);
  assert.equal(P.isPaymentUiEnabled('evil-staging.playxcafe.com.example.com'), false);
  assert.equal(P.isPaymentUiEnabled('playxcafe.com.example.com'), false);
  assert.equal(P.isPaymentUiEnabled('main.d1abc.amplifyapp.com'), false);
  assert.equal(P.isPaymentUiEnabled(undefined), false);
});

test('checkout context: current context is used, stale one is discarded', () => {
  const now = Date.now();
  const fresh = memoryStorage({ [P.CHECKOUT_STORAGE_KEY]: JSON.stringify({ bookingId: BOOKING_ID, startedAt: now - 60 * 1000 }) });
  assert.equal(P.resolveBookingId('', fresh, now), BOOKING_ID);

  const stale = memoryStorage({ [P.CHECKOUT_STORAGE_KEY]: JSON.stringify({ bookingId: BOOKING_ID, startedAt: now - P.CHECKOUT_MAX_AGE_MS - 1 }) });
  assert.equal(P.resolveBookingId('', stale, now), null);
  assert.equal(stale.getItem(P.CHECKOUT_STORAGE_KEY), null); // discarded

  const noTime = memoryStorage({ [P.CHECKOUT_STORAGE_KEY]: JSON.stringify({ bookingId: BOOKING_ID }) });
  assert.equal(P.readCheckoutContext(noTime, now), null);
});

test('stale context does not override an explicit valid bookingId from the return URL', () => {
  const now = Date.now();
  const stale = memoryStorage({ [P.CHECKOUT_STORAGE_KEY]: JSON.stringify({ bookingId: BOOKING_ID, startedAt: now - P.CHECKOUT_MAX_AGE_MS - 1 }) });
  assert.equal(P.resolveBookingId(`?bookingId=${OTHER_ID}`, stale, now), OTHER_ID);
});
