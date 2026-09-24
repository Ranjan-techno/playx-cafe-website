// Run with: node --test tests/
// Covers js/api-routes.js - hostname -> SANDBOX/PRODUCTION booking/payment routing - and how
// js/payments.js, js/script.js and payment-return.html use it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('../js/api-routes.js');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const BOOKING_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const API = 'https://api.test';

/** Loads the real browser scripts (api-routes.js, then payments.js) into a fresh window-like
 *  context served from `href`, with fetch/storage/Cognito stubbed. Returns the fetch log. */
function loadBrowserPage(href, { fetchResponse, storage = {} } = {}) {
  const url = new URL(href);
  const calls = [];
  const navigations = [];
  const location = {
    hostname: url.hostname,
    search: url.search,
    hash: url.hash,
    set href(v) { navigations.push(v); },
    get href() { return url.href; }
  };
  const store = { ...storage };
  const ctx = {
    URL,
    URLSearchParams,
    location,
    AWS_CONFIG: { apiBaseUrl: API },
    CognitoAuth: { isConfigured: true, getAccessToken: async () => 'header.payload.sig' },
    sessionStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; }
    },
    localStorage: { getItem: () => 'PRODUCTION', setItem() {}, removeItem() {} },
    fetch: async (u, init) => {
      calls.push({ url: u, init });
      return fetchResponse ? fetchResponse(u, init) : { ok: true, status: 200, json: async () => ({}) };
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(read('js/api-routes.js'), ctx, { filename: 'api-routes.js' });
  vm.runInContext(read('js/payments.js'), ctx, { filename: 'payments.js' });
  return { ctx, calls, navigations };
}

const startOk = () => ({
  ok: true,
  status: 200,
  json: async () => ({ bookingId: BOOKING_ID, redirectUrl: 'https://mercury.phonepe.com/transact/pg?token=x' })
});

// ---- route selection ------------------------------------------------------------------------
test('production hostnames select the PRODUCTION booking, payment-start and status routes', () => {
  for (const host of ['playxcafe.com', 'www.playxcafe.com', 'PlayXCafe.com', 'WWW.PLAYXCAFE.COM']) {
    assert.equal(R.environmentForHostname(host), 'PRODUCTION', host);
    const routes = R.routesForHostname(host);
    assert.equal(routes.environment, 'PRODUCTION');
    assert.equal(routes.createBooking, '/bookings/production');
    assert.equal(routes.startPayment, '/payments/production/start');
    assert.equal(routes.paymentStatus(BOOKING_ID), `/payments/production/${BOOKING_ID}/status`);
  }
});

test('staging stays SANDBOX: POST /bookings, POST /payments/start, GET /payments/{id}/status', () => {
  const routes = R.routesForHostname('staging.playxcafe.com');
  assert.equal(R.environmentForHostname('staging.playxcafe.com'), 'SANDBOX');
  assert.equal(routes.environment, 'SANDBOX');
  assert.equal(routes.createBooking, '/bookings');
  assert.equal(routes.startPayment, '/payments/start');
  assert.equal(routes.paymentStatus(BOOKING_ID), `/payments/${BOOKING_ID}/status`);
});

test('local, preview, look-alike and unknown hosts fall back to SANDBOX, never PRODUCTION', () => {
  for (const host of [
    'localhost', '127.0.0.1', 'main.d1abc.amplifyapp.com', 'ranjan-techno.github.io',
    'playxcafe.com.example.com', 'evilplayxcafe.com', 'playxcafe.co', 'api.playxcafe.com',
    'playxcafe.com.', ' playxcafe.com', '', undefined, null, 42, {}
  ]) {
    assert.equal(R.environmentForHostname(host), 'SANDBOX', String(host));
    assert.equal(R.routesForHostname(host), R.ROUTES.SANDBOX, String(host));
  }
});

test('status route encodes the booking id; it cannot be used to escape the path', () => {
  assert.equal(R.ROUTES.PRODUCTION.paymentStatus('../../bookings'), '/payments/production/..%2F..%2Fbookings/status');
  assert.equal(R.ROUTES.SANDBOX.paymentStatus('a/b?c'), '/payments/a%2Fb%3Fc/status');
});

test('route tables are frozen: page scripts cannot re-point SANDBOX at PRODUCTION', () => {
  assert.ok(Object.isFrozen(R.ROUTES) && Object.isFrozen(R.ROUTES.SANDBOX) && Object.isFrozen(R.ROUTES.PRODUCTION));
  assert.ok(Object.isFrozen(R.PRODUCTION_HOSTNAMES) && Object.isFrozen(R.PAYMENT_UI_HOSTNAMES));
  assert.throws(() => { 'use strict'; R.ROUTES.SANDBOX.createBooking = '/bookings/production'; }, TypeError);
  assert.throws(() => R.PRODUCTION_HOSTNAMES.push('staging.playxcafe.com'), TypeError);
  assert.equal(R.routesForHostname('staging.playxcafe.com').createBooking, '/bookings');
});

// ---- no client-controlled environment override ---------------------------------------------
test('no override: query string, hash and storage cannot switch staging to PRODUCTION (or production to SANDBOX)', () => {
  const staging = loadBrowserPage('https://staging.playxcafe.com/payment-return.html?environment=PRODUCTION&env=production#PRODUCTION');
  assert.equal(staging.ctx.PlayXApiRoutes.currentRoutes().environment, 'SANDBOX');
  const prod = loadBrowserPage('https://playxcafe.com/payment-return.html?environment=SANDBOX&env=sandbox#SANDBOX');
  assert.equal(prod.ctx.PlayXApiRoutes.currentRoutes().environment, 'PRODUCTION');
});

test('no override: the routing helper reads only location.hostname - no search/hash/storage/cookie/API input', () => {
  const src = read('js/api-routes.js').replace(/^\s*\/\/.*$/gm, '');
  assert.match(src, /root\.location && root\.location\.hostname/);
  for (const forbidden of [/\.search\b/, /\.hash\b/, /URLSearchParams/, /localStorage/, /sessionStorage/, /document\.cookie/, /fetch\(/, /AWS_CONFIG/]) {
    assert.doesNotMatch(src, forbidden, String(forbidden));
  }
  // Only the two exact production hostnames are PRODUCTION.
  assert.deepEqual([...R.PRODUCTION_HOSTNAMES], ['playxcafe.com', 'www.playxcafe.com']);
});

// ---- the real browser wiring (payments.js getBrowserClient) ---------------------------------
test('playxcafe.com: payment start and status go to the PRODUCTION routes', async () => {
  const page = loadBrowserPage('https://playxcafe.com/', { fetchResponse: startOk });
  const client = page.ctx.PlayXPayments.getBrowserClient();
  assert.equal(JSON.stringify(await client.startPayment(BOOKING_ID)), '{"ok":true}');
  await client.getPaymentStatus(BOOKING_ID);
  assert.deepEqual(page.calls.map((c) => `${c.init.method} ${c.url}`), [
    `POST ${API}/payments/production/start`,
    `GET ${API}/payments/production/${BOOKING_ID}/status`
  ]);
  assert.deepEqual(JSON.parse(page.calls[0].init.body), { bookingId: BOOKING_ID }, 'no amount/environment sent');
});

test('staging.playxcafe.com: payment start and status stay on the SANDBOX routes', async () => {
  const page = loadBrowserPage('https://staging.playxcafe.com/', { fetchResponse: startOk });
  const client = page.ctx.PlayXPayments.getBrowserClient();
  await client.startPayment(BOOKING_ID);
  await client.getPaymentStatus(BOOKING_ID);
  assert.deepEqual(page.calls.map((c) => `${c.init.method} ${c.url}`), [
    `POST ${API}/payments/start`,
    `GET ${API}/payments/${BOOKING_ID}/status`
  ]);
  assert.deepEqual(JSON.parse(page.calls[0].init.body), { bookingId: BOOKING_ID });
});

test('PhonePe return on playxcafe.com polls the PRODUCTION status route; success=/code= params are ignored', async () => {
  const href = `https://playxcafe.com/payment-return.html?bookingId=${BOOKING_ID}&success=true&code=PAYMENT_SUCCESS&state=COMPLETED`;
  const page = loadBrowserPage(href, {
    fetchResponse: () => ({ ok: true, status: 200, json: async () => ({ outcome: 'pending', bookingStatus: 'pending' }) })
  });
  const P = page.ctx.PlayXPayments;
  const bookingId = P.resolveBookingId(page.ctx.location.search, page.ctx.sessionStorage);
  assert.equal(bookingId, BOOKING_ID);
  const result = await P.getBrowserClient().getPaymentStatus(bookingId);
  assert.deepEqual(page.calls.map((c) => c.url), [`${API}/payments/production/${BOOKING_ID}/status`]);
  // The backend said pending, so the page says processing - whatever the URL claimed.
  assert.equal(P.describePaymentStatus(result.status).state, 'pending');
});

test('PhonePe return on staging polls the SANDBOX status route', async () => {
  const page = loadBrowserPage(`https://staging.playxcafe.com/payment-return.html?bookingId=${BOOKING_ID}`);
  const P = page.ctx.PlayXPayments;
  await P.getBrowserClient().getPaymentStatus(P.resolveBookingId(page.ctx.location.search, page.ctx.sessionStorage));
  assert.deepEqual(page.calls.map((c) => c.url), [`${API}/payments/${BOOKING_ID}/status`]);
});

test('createPaymentClient without explicit routes defaults to SANDBOX (PRODUCTION is always opt-in by hostname)', async () => {
  const P = require('../js/payments.js');
  const calls = [];
  const client = P.createPaymentClient({
    apiBaseUrl: API,
    getToken: async () => 't',
    fetchImpl: async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({}) }; },
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
    redirect() {}
  });
  await client.getPaymentStatus(BOOKING_ID);
  assert.deepEqual(calls, [`${API}/payments/${BOOKING_ID}/status`]);
});

// ---- page scripts use the helper, not hard-coded paths --------------------------------------
test('js/script.js creates bookings through the hostname route (POST /bookings/production on playxcafe.com)', () => {
  const src = read('js/script.js');
  assert.match(src, /fetch\(`\$\{AWS_CONFIG\.apiBaseUrl\}\$\{PlayXApiRoutes\.currentRoutes\(\)\.createBooking\}`/);
  assert.doesNotMatch(src, /apiBaseUrl\}\/bookings[`/]/, 'no hard-coded booking path left');
  assert.doesNotMatch(src, /apiBaseUrl\}\/payments/, 'payments go through js/payments.js');
  // And no environment picked from anything the visitor controls.
  assert.doesNotMatch(src, /[?&]environment=|getItem\(['"][^'"]*env/i);
});

test('js/payments.js and js/payment-return.js have no hard-coded payment paths', () => {
  const payments = read('js/payments.js');
  assert.doesNotMatch(payments, /authorizedFetch\(['`]\/payments/);
  assert.match(payments, /authorizedFetch\(routes\.startPayment/);
  assert.match(payments, /authorizedFetch\(routes\.paymentStatus\(bookingId\)/);
  assert.match(payments, /routes: ApiRoutes\.currentRoutes\(\)/);
  const ret = read('js/payment-return.js');
  assert.doesNotMatch(ret, /fetch\(/);
  assert.match(ret, /PlayXPayments\.getBrowserClient\(\)/);
});

test('pages load js/api-routes.js before js/payments.js (and before js/script.js on index.html)', () => {
  for (const page of ['index.html', 'payment-return.html']) {
    const html = read(page);
    const routes = html.indexOf('<script src="js/api-routes.js"></script>');
    const payments = html.indexOf('<script src="js/payments.js"></script>');
    assert.ok(routes > 0 && payments > routes, page);
  }
  const index = read('index.html');
  assert.ok(index.indexOf('<script src="js/api-routes.js"></script>') < index.indexOf('<script src="js/script.js"></script>'));
});

// ---- no production secrets in frontend -----------------------------------------------------
test('no PhonePe credentials, secret names or tester allowlists anywhere in frontend JS/HTML', () => {
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'js')).filter((f) => f.endsWith('.js')).map((f) => `js/${f}`),
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))
  ];
  assert.ok(files.includes('js/api-routes.js') && files.includes('payment-return.html'));
  for (const file of files) {
    const src = read(file);
    for (const needle of [
      /playx\/phonepe/i, /clientSecret/i, /client_secret/i, /clientVersion/i, /webhookUsername/i,
      /webhookPassword/i, /PHONEPE_PRODUCTION_TESTERS/, /PHONEPE_SANDBOX_TESTERS/, /PHONEPE_SECRET/,
      /PHONEPE_PRODUCTION_ACCESS_MODE/,
      /secretsmanager/i, /AKIA[0-9A-Z]{16}/
    ]) {
      assert.doesNotMatch(src, needle, `${file} must not contain ${needle}`);
    }
  }
});

// ---- Stage 2E: environment-isolated My Bookings ------------------------------------------------
test('My Bookings route: playxcafe.com / www -> GET /bookings/production/me; staging, local and unknown hosts -> GET /bookings/me', () => {
  for (const host of ['playxcafe.com', 'www.playxcafe.com', 'PLAYXCAFE.COM']) {
    assert.equal(R.routesForHostname(host).myBookings, '/bookings/production/me', host);
  }
  for (const host of ['staging.playxcafe.com', 'localhost', '127.0.0.1', 'preview.example.com', 'playxcafe.com.evil.test', '', undefined]) {
    assert.equal(R.routesForHostname(host).myBookings, '/bookings/me', String(host));
  }
});

/** Runs the real js/api-routes.js + js/my-bookings.js in a minimal window/document stub served from
 *  `href` and returns the URL(s) My Bookings fetched on load. */
async function myBookingsFetchesOn(href) {
  const url = new URL(href);
  const calls = [];
  const el = () => ({
    hidden: false, textContent: '', innerHTML: '', dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, setAttribute() {}
  });
  const elements = {};
  const context = {
    location: url,
    console: { error() {}, log() {} },
    AWS_CONFIG: { apiBaseUrl: API },
    CognitoAuth: { isConfigured: true, getAccessToken: async () => 'jwt' },
    fetch: async (u) => { calls.push(u); return { ok: true, status: 200, json: async () => ({ bookings: [] }) }; },
    document: {
      getElementById: (id) => (elements[id] = elements[id] || el()),
      createElement: el,
      querySelectorAll: () => []
    },
    Intl, Date, Promise, URL, URLSearchParams, Object, Array, Number, String, JSON
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(read('js/api-routes.js'), context);
  vm.runInContext(read('js/my-bookings.js'), context);
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  return calls;
}

test('My Bookings on playxcafe.com / www fetches ONLY the PRODUCTION list; staging and localhost fetch ONLY the SANDBOX list', async () => {
  assert.deepEqual(await myBookingsFetchesOn('https://playxcafe.com/#my-bookings'), [`${API}/bookings/production/me`]);
  assert.deepEqual(await myBookingsFetchesOn('https://www.playxcafe.com/'), [`${API}/bookings/production/me`]);
  assert.deepEqual(await myBookingsFetchesOn('https://staging.playxcafe.com/'), [`${API}/bookings/me`]);
  assert.deepEqual(await myBookingsFetchesOn('http://localhost:8000/'), [`${API}/bookings/me`]);
});

test('My Bookings: query string / hash cannot switch environment (no ?environment= is ever sent)', async () => {
  assert.deepEqual(await myBookingsFetchesOn('https://playxcafe.com/?environment=SANDBOX#env=SANDBOX'), [`${API}/bookings/production/me`]);
  assert.deepEqual(await myBookingsFetchesOn('https://staging.playxcafe.com/?environment=PRODUCTION'), [`${API}/bookings/me`]);
  const src = read('js/my-bookings.js');
  assert.match(src, /\$\{PlayXApiRoutes\.currentRoutes\(\)\.myBookings\}/);
  assert.doesNotMatch(src, /apiBaseUrl\}\/bookings/, 'no hard-coded bookings path');
  assert.doesNotMatch(src, /[?&]environment=/);
});

test('index.html loads js/api-routes.js before js/my-bookings.js', () => {
  const index = read('index.html');
  assert.ok(index.indexOf('<script src="js/api-routes.js"></script>') < index.indexOf('<script src="js/my-bookings.js"></script>'));
});
