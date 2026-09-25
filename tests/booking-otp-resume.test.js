// Run with: node --test tests/
// Covers js/script.js's post-OTP booking journey: Reserve My Race -> OTP -> POST /bookings must
// land the customer on that booking's payment step (not the My Bookings section below it), reuse
// the one booking it created, and never start PhonePe on its own. js/script.js is plain
// global-scope browser code, so it runs here in a vm context against a minimal stub DOM, together
// with the real pricing/format/product/api-routes/payments scripts it depends on.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const BOOKING_ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const EMAIL = 'racer@example.com';

// Ids that index.html renders with the `hidden` attribute, so the stub DOM starts in the same state.
const INITIALLY_HIDDEN = (() => {
  const ids = new Set();
  for (const tag of read('index.html').match(/<[a-z][^>]*\sid="[^"]+"[^>]*>/gi)) {
    if (/\shidden(\s|>|=)/.test(tag)) ids.add(/\sid="([^"]+)"/.exec(tag)[1]);
  }
  return ids;
})();

function memoryStorage() {
  const data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// Loads index.html's booking scripts into a fresh context. `bookingResponse` is what POST
// /bookings answers. Returns the stub DOM plus logs of every request, visibility change and scroll.
function loadPage({ bookingResponse }) {
  const log = [];       // ['hidden', id, value] | ['scroll', id] | ['focus', id]
  const requests = [];  // { method, path, body }
  const elements = new Map();
  let accessToken = null;

  function makeEl(id) {
    const listeners = {};
    const classes = new Set();
    let hidden = INITIALLY_HIDDEN.has(id);
    return {
      id,
      get hidden() { return hidden; },
      set hidden(v) { if (v !== hidden) log.push(['hidden', id, v]); hidden = v; },
      value: '', textContent: '', innerHTML: '', className: '', disabled: false, required: false,
      dataset: {}, style: {}, validationMessage: '',
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        contains: (c) => classes.has(c),
        toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; on ? classes.add(c) : classes.delete(c); return on; }
      },
      addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatchEvent(ev) { (listeners[ev.type] || []).forEach((fn) => fn(ev)); return true; },
      async fire(type) { await Promise.all((listeners[type] || []).map((fn) => fn({ type, preventDefault() {} }))); },
      focus() { log.push(['focus', id]); },
      scrollIntoView() { log.push(['scroll', id]); },
      reset() { this.dispatchEvent({ type: 'reset' }); },
      setAttribute() {}, removeAttribute() {}, appendChild() {}, setCustomValidity() {},
      querySelector: () => makeEl(null),
      querySelectorAll: () => []
    };
  }

  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  };
  const digits = (prefix) => Array.from({ length: 6 }, (_, i) => getEl(`${prefix}${i}`));
  const otpDigits = digits('otpDigit');
  const myBookingsOtpDigits = digits('mbOtpDigit');

  const location = { hostname: 'localhost', href: 'http://localhost:8000/index.html', hash: '', reload() {} };
  const refreshMyBookingsCalls = [];

  async function fetchStub(url, init = {}) {
    const route = url.replace('https://api.test', '');
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method || 'GET', path: route, body });
    if (route === '/auth/start') return jsonResponse(200, { challenge: 'CUSTOM_CHALLENGE', session: 'challenge-session' });
    if (route === '/auth/verify') return jsonResponse(200, { idToken: 'id', accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 });
    if (route === '/bookings') return jsonResponse(201, bookingResponse);
    if (route === '/payments/start') {
      return jsonResponse(200, {
        bookingId: body.bookingId, bookingNumber: 1040, paymentStatus: 'pending',
        redirectUrl: 'https://mercury-uat.phonepe.com/transact/uat_v2?token=t', expiresAt: '2026-09-26T10:00:00.000Z'
      });
    }
    return jsonResponse(404, {});
  }

  const context = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout, Intl, Date, URL, URLSearchParams,
    Event: class { constructor(type) { this.type = type; } },
    location,
    sessionStorage: memoryStorage(),
    localStorage: memoryStorage(),
    fetch: fetchStub,
    addEventListener() {},
    AWS_CONFIG: { apiBaseUrl: 'https://api.test' },
    CognitoAuth: {
      isConfigured: true,
      getAccessToken: async () => accessToken,
      getIdTokenClaims: async () => (accessToken ? { email: EMAIL } : null),
      installPasswordlessSession: async (_email, result) => { accessToken = result.accessToken; }
    },
    refreshMyBookings: () => { refreshMyBookingsCalls.push(Date.now()); },
    document: {
      getElementById: getEl,
      querySelector: () => makeEl(null),
      querySelectorAll: (sel) => (sel === '.otp-digit' ? otpDigits : sel === '.mb-otp-digit' ? myBookingsOtpDigits : []),
      createElement: () => makeEl(null)
    }
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['js/pricing-config.js', 'js/product-lookup.js', 'js/format-utils.js', 'js/api-routes.js', 'js/payments.js', 'js/script.js']) {
    vm.runInContext(read(file), context, { filename: file });
  }

  return { el: getEl, log, requests, location, otpDigits, myBookingsOtpDigits, refreshMyBookingsCalls, sessionStorage: context.sessionStorage };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const DRAFT = {
  productCode: 'solo-quick-motion', bookingDate: '2026-09-26', startTime: '15:00',
  customerName: 'Racer', customerPhone: '9876543210', customerEmail: EMAIL, notes: null,
  display: { xperienceName: 'Quick Race', simulatorType: 'Motion', durationMinutes: 15, price: 599 }
};

const pendingBooking = (overrides = {}) => ({
  id: BOOKING_ID, bookingNumber: 1040, product: 'solo-quick-motion', date: '2026-09-26', time: '15:00',
  price: 599, status: 'pending', holdExpiresAt: '2026-09-26T09:40:00.000Z', ...overrides
});

// Booking flow: saved draft -> Reserve My Race -> 6-digit OTP -> Verify Code (which then creates
// the booking automatically, exactly as in the browser).
async function runBookingFlowThroughOtp(page) {
  page.sessionStorage.setItem('playx_pending_booking', JSON.stringify(DRAFT));
  page.el('bookingForm').hidden = true;
  page.el('reservationReview').hidden = false; // the Review screen the customer is on
  await page.el('reserveRaceBtn').fire('click');
  await settle();
  assert.equal(page.el('otpVerification').hidden, false, 'OTP step shown');
  page.otpDigits.forEach((d, i) => { d.value = String(i + 1); });
  await page.el('verifyOtpBtn').fire('click');
  await settle();
}

const bookingPosts = (page) => page.requests.filter((r) => r.method === 'POST' && r.path === '/bookings');
const paymentStarts = (page) => page.requests.filter((r) => r.path === '/payments/start');

test('booking flow + OTP success resumes on the booking result/payment step', async () => {
  const page = loadPage({ bookingResponse: pendingBooking() });
  await runBookingFlowThroughOtp(page);

  assert.equal(page.el('bookingResult').hidden, false, 'booking result shown');
  assert.equal(page.el('paymentStep').hidden, false, 'payment step shown');
  assert.equal(page.el('reservationReview').hidden, true);
  assert.equal(page.el('bookingCreationPanel').hidden, true);
  assert.equal(page.el('resultReference').textContent, 'Booking #1040');
  assert.equal(page.el('resultStatus').textContent, 'Pending Confirmation');
});

test('after OTP the customer is not sent to My Bookings: nothing above the result collapses after it is scrolled to', async () => {
  const page = loadPage({ bookingResponse: pendingBooking() });
  await runBookingFlowThroughOtp(page);

  const scrolls = page.log.filter((e) => e[0] === 'scroll').map((e) => e[1]);
  assert.deepEqual(scrolls, ['bookingResult'], 'the only scroll target is the booking result');
  assert.equal(page.location.hash, '');
  assert.equal(page.location.href, 'http://localhost:8000/index.html');

  // The original bug: #reservationReview (above #bookingResult) was hidden *after* the result was
  // revealed/scrolled to, shrinking the page above the viewport and leaving My Bookings on screen.
  const scrollAt = page.log.findIndex((e) => e[0] === 'scroll' && e[1] === 'bookingResult');
  const aboveResult = ['bookingForm', 'reservationReview', 'otpVerification', 'bookingCreationPanel'];
  const collapsedAfter = page.log.slice(scrollAt).filter((e) => e[0] === 'hidden' && e[2] === true && aboveResult.includes(e[1]));
  assert.deepEqual(collapsedAfter, []);
  const shownAt = page.log.findIndex((e) => e[0] === 'hidden' && e[1] === 'bookingResult' && e[2] === false);
  const reviewHiddenAt = page.log.findIndex((e) => e[0] === 'hidden' && e[1] === 'reservationReview' && e[2] === true);
  assert.ok(reviewHiddenAt > -1 && reviewHiddenAt < shownAt, 'review card collapses before the result is revealed');
});

test('a pending booking shows PAY SECURELY WITH PHONEPE and does not auto-start PhonePe', async () => {
  const page = loadPage({ bookingResponse: pendingBooking() });
  await runBookingFlowThroughOtp(page);

  assert.equal(page.el('payNowBtn').hidden, false);
  assert.equal(page.el('payNowBtn').disabled, false);
  assert.equal(page.el('payNowBtn').textContent, 'PAY SECURELY WITH PHONEPE');
  assert.equal(paymentStarts(page).length, 0, 'no payment started until the customer clicks');
});

test('the created bookingId is reused: one POST /bookings, and Pay starts payment for that same id', async () => {
  const page = loadPage({ bookingResponse: pendingBooking() });
  await runBookingFlowThroughOtp(page);
  assert.equal(bookingPosts(page).length, 1);
  assert.deepEqual(Object.keys(bookingPosts(page)[0].body).sort(),
    ['bookingDate', 'customerEmail', 'customerName', 'customerPhone', 'notes', 'productCode', 'startTime']);

  // The draft is consumed, so a stray second Verify can't create another booking.
  assert.equal(page.sessionStorage.getItem('playx_pending_booking'), null);
  await page.el('verifyOtpBtn').fire('click');
  await settle();
  assert.equal(bookingPosts(page).length, 1, 'no duplicate booking');

  await page.el('payNowBtn').fire('click');
  assert.equal(paymentStarts(page).length, 1);
  assert.deepEqual(paymentStarts(page)[0].body, { bookingId: BOOKING_ID });
  assert.equal(page.location.href, 'https://mercury-uat.phonepe.com/transact/uat_v2?token=t');
});

test('generic My Bookings sign-in (no booking intent) keeps the existing My Bookings behavior', async () => {
  const page = loadPage({ bookingResponse: pendingBooking() });
  page.el('myBookingsEmail').value = EMAIL;
  await page.el('myBookingsAuthForm').fire('submit');
  await settle();
  page.myBookingsOtpDigits.forEach((d, i) => { d.value = String(i + 1); });
  await page.el('myBookingsVerifyBtn').fire('click');
  await settle();

  assert.equal(page.refreshMyBookingsCalls.length, 1, 'My Bookings list refreshed');
  assert.equal(bookingPosts(page).length, 0, 'no booking created');
  assert.equal(page.el('bookingResult').hidden, true);
  assert.equal(page.el('paymentStep').hidden, true);
  assert.equal(page.log.some((e) => e[0] === 'scroll'), false);
});

test('an already-confirmed booking shows its confirmed state and no payment CTA', async () => {
  const page = loadPage({ bookingResponse: pendingBooking({ status: 'confirmed', holdExpiresAt: null }) });
  await runBookingFlowThroughOtp(page);

  assert.equal(page.el('bookingResult').hidden, false);
  assert.equal(page.el('resultStatus').textContent, 'Confirmed');
  assert.equal(page.el('paymentStep').hidden, true);
  assert.equal(paymentStarts(page).length, 0);
});

test('a pending booking that cannot be resumed here points the customer to My Bookings', async () => {
  const page = loadPage({ bookingResponse: pendingBooking({ id: 'not-a-uuid' }) });
  await runBookingFlowThroughOtp(page);

  assert.equal(page.el('paymentStep').hidden, false);
  assert.equal(page.el('payNowBtn').hidden, true);
  assert.match(page.el('paymentStepStatus').textContent, /My Bookings/);
  await page.el('payNowBtn').fire('click');
  assert.equal(paymentStarts(page).length, 0);
});
