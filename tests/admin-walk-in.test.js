// Run with: node --test tests/
// Covers js/admin-walk-in.js - the DOM-free core of the Stage 3A.2 admin walk-in booking workflow.
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../js/admin-walk-in.js');

const CATALOG = [
  { productCode: 'grand-race', name: 'Grand Race', productType: 'session', simulatorType: null, racers: 6, durationMinutes: 60, priceInr: 6000 },
  { productCode: 'race-pass-1000', name: 'Race Pass', productType: 'race_pass', simulatorType: null, racers: null, durationMinutes: null, priceInr: 1000 },
  { productCode: 'solo-pro-motion', name: 'Solo Pro', productType: 'session', simulatorType: 'motion', racers: 1, durationMinutes: 30, priceInr: 1000 }
];

const FORM = {
  name: '  Asha Rao ',
  phone: ' 98765 43210 ',
  email: '',
  productCode: 'solo-pro-motion',
  bookingDate: '2026-10-01',
  startTime: '18:00',
  paymentMethod: 'CASH',
  paymentReference: '',
  notes: ''
};

// ---- catalog ------------------------------------------------------------------------------
test('only session products are offered - race passes never appear', () => {
  const sessions = W.sessionProducts(CATALOG);
  assert.deepEqual(sessions.map((p) => p.productCode), ['grand-race', 'solo-pro-motion']);
  assert.ok(sessions.every((p) => p.productType === 'session'));
  assert.deepEqual(W.sessionProducts(undefined), []);
  assert.deepEqual(W.sessionProducts([{ productType: 'race_pass', productCode: 'x' }, null]), []);
});

test('product option label shows server name, duration, simulator type, racers and price', () => {
  assert.equal(W.productOptionLabel(CATALOG[2]), 'Solo Pro · 30 min · Motion · 1 racer · ₹1,000');
  assert.equal(W.productOptionLabel(CATALOG[0]), 'Grand Race · 60 min · — · 6 racers · ₹6,000');
});

// ---- availability -------------------------------------------------------------------------
test('availability always uses the PRODUCTION route, with encoded params', () => {
  assert.equal(
    W.availabilityPath('solo-pro-motion', '2026-10-01'),
    '/availability/production?productCode=solo-pro-motion&date=2026-10-01'
  );
  assert.match(W.availabilityPath('a&b', '2026-10-01'), /productCode=a%26b/);
  assert.doesNotMatch(W.availabilityPath('x', '2026-10-01'), /^\/availability\?/);
});

test('past dates are rejected client-side; today and future are allowed', () => {
  assert.equal(W.isPastDate('2026-09-28', '2026-09-29'), true);
  assert.equal(W.isPastDate('2026-09-29', '2026-09-29'), false);
  assert.equal(W.isPastDate('2026-10-01', '2026-09-29'), false);
  assert.equal(W.isPastDate('', '2026-09-29'), false);
});

test('on today, slots at or before the current IST minute are hidden; other days untouched', () => {
  const slots = ['11:00', '17:45', '18:00', '18:15', 'bogus'];
  // 18:00 IST now
  assert.deepEqual(W.filterUpcomingSlots(slots, '2026-09-29', '2026-09-29', 18 * 60), ['18:15']);
  assert.deepEqual(W.filterUpcomingSlots(slots, '2026-09-30', '2026-09-29', 18 * 60), ['11:00', '17:45', '18:00', '18:15']);
  assert.deepEqual(W.filterUpcomingSlots(undefined, '2026-09-30', '2026-09-29', 0), []);
});

// ---- payment reference --------------------------------------------------------------------
test('UPI and CARD take a payment reference; CASH and COMPLIMENTARY do not', () => {
  assert.equal(W.paymentReferenceApplies('UPI'), true);
  assert.equal(W.paymentReferenceApplies('CARD'), true);
  assert.equal(W.paymentReferenceApplies('CASH'), false);
  assert.equal(W.paymentReferenceApplies('COMPLIMENTARY'), false);
});

test('UPI/CARD payload carries the trimmed reference (or null when blank)', () => {
  assert.equal(W.buildWalkInPayload({ ...FORM, paymentMethod: 'UPI', paymentReference: ' 412345678901 ' }).paymentReference, '412345678901');
  assert.equal(W.buildWalkInPayload({ ...FORM, paymentMethod: 'CARD', paymentReference: 'SLIP-77' }).paymentReference, 'SLIP-77');
  assert.equal(W.buildWalkInPayload({ ...FORM, paymentMethod: 'UPI', paymentReference: '   ' }).paymentReference, null);
});

test('CASH/COMPLIMENTARY never send a reference, even if one was typed', () => {
  assert.equal(W.buildWalkInPayload({ ...FORM, paymentMethod: 'CASH', paymentReference: 'LEFTOVER' }).paymentReference, null);
  assert.equal(W.buildWalkInPayload({ ...FORM, paymentMethod: 'COMPLIMENTARY', paymentReference: 'LEFTOVER' }).paymentReference, null);
});

test('invalid UPI/CARD reference is caught before review; ignored for CASH', () => {
  const bad = { ...FORM, paymentMethod: 'UPI', paymentReference: 'abc<script>' };
  assert.equal(W.validateWalkInForm(bad, '2026-09-29').field, 'reference');
  assert.equal(W.validateWalkInForm({ ...FORM, paymentMethod: 'UPI', paymentReference: 'x'.repeat(65) }, '2026-09-29').field, 'reference');
  assert.equal(W.validateWalkInForm({ ...bad, paymentMethod: 'CASH' }, '2026-09-29'), null);
});

// ---- payload ------------------------------------------------------------------------------
test('payload is exactly the Stage 3A.1 contract - no price/environment/simulator/status/source', () => {
  const tampered = {
    ...FORM,
    email: ' Asha@Example.com ',
    notes: ' birthday ',
    priceInr: 1,
    price: 1,
    environment: 'SANDBOX',
    bookingEnvironment: 'SANDBOX',
    simulator: 'S1',
    simulators: ['S1'],
    simulatorType: 'static',
    durationMinutes: 999,
    status: 'completed',
    bookingSource: 'ONLINE'
  };
  const payload = W.buildWalkInPayload(tampered);
  assert.deepEqual(Object.keys(payload).sort(), [
    'bookingDate', 'customer', 'notes', 'paymentMethod', 'paymentReference', 'productCode', 'startTime'
  ]);
  assert.deepEqual(Object.keys(payload.customer).sort(), ['email', 'name', 'phone']);
  assert.deepEqual(payload, {
    productCode: 'solo-pro-motion',
    bookingDate: '2026-10-01',
    startTime: '18:00',
    customer: { name: 'Asha Rao', phone: '98765 43210', email: 'Asha@Example.com' },
    paymentMethod: 'CASH',
    paymentReference: null,
    notes: 'birthday'
  });
  const json = JSON.stringify(payload);
  for (const forbidden of ['price', 'environment', 'simulator', 'status', 'duration', 'bookingSource', 'SANDBOX']) {
    assert.doesNotMatch(json, new RegExp(forbidden, 'i'), `payload must not contain ${forbidden}`);
  }
});

test('blank optional email/notes are sent as null', () => {
  const payload = W.buildWalkInPayload({ ...FORM, email: '  ', notes: '' });
  assert.equal(payload.customer.email, null);
  assert.equal(payload.notes, null);
});

// ---- form validation ----------------------------------------------------------------------
test('required fields are enforced in order; a complete form passes', () => {
  const today = '2026-09-29';
  assert.equal(W.validateWalkInForm(FORM, today), null);
  assert.equal(W.validateWalkInForm({ ...FORM, name: ' ' }, today).field, 'name');
  assert.equal(W.validateWalkInForm({ ...FORM, phone: '' }, today).field, 'phone');
  assert.equal(W.validateWalkInForm({ ...FORM, phone: '12345' }, today).field, 'phone');
  assert.equal(W.validateWalkInForm({ ...FORM, email: 'not-an-email' }, today).field, 'email');
  assert.equal(W.validateWalkInForm({ ...FORM, productCode: '' }, today).field, 'product');
  assert.equal(W.validateWalkInForm({ ...FORM, bookingDate: '' }, today).field, 'date');
  assert.equal(W.validateWalkInForm({ ...FORM, bookingDate: '2026-09-01' }, today).field, 'date');
  assert.equal(W.validateWalkInForm({ ...FORM, startTime: '' }, today).field, 'time');
  assert.equal(W.validateWalkInForm({ ...FORM, paymentMethod: '' }, today).field, 'payment');
  assert.equal(W.validateWalkInForm({ ...FORM, paymentMethod: 'PHONEPE' }, today).field, 'payment');
});

test('phone shapes match the backend normalizer (10 digits, 0+10, 91+10)', () => {
  const today = '2026-09-29';
  for (const ok of ['9876543210', '09876543210', '919876543210', '+91 98765 43210', '98765-43210']) {
    assert.equal(W.validateWalkInForm({ ...FORM, phone: ok }, today), null, ok);
  }
  for (const bad of ['987654321', '98765432101', '+1 555 123 4567']) {
    assert.equal(W.validateWalkInForm({ ...FORM, phone: bad }, today).field, 'phone', bad);
  }
});

test('review preview: COMPLIMENTARY collects ₹0, others collect the catalog price', () => {
  assert.equal(W.previewAmountInr('COMPLIMENTARY', 1000), 0);
  assert.equal(W.previewAmountInr('CASH', 1000), 1000);
  assert.equal(W.previewAmountInr('UPI', '1500'), 1500);
});

// ---- submission outcomes ------------------------------------------------------------------
test('result classification: 409 -> conflict, 400/404 -> backend message, 401/403 -> session exits', () => {
  assert.deepEqual(W.classifyWalkInResult({ kind: 'ok', data: {} }), { action: 'ok' });
  const conflict = W.classifyWalkInResult({ kind: 'error', status: 409, data: { message: 'No simulator...' } });
  assert.equal(conflict.action, 'conflict');
  assert.match(conflict.message, /no longer available/);
  assert.deepEqual(
    W.classifyWalkInResult({ kind: 'error', status: 400, data: { message: 'startTime has already passed' } }),
    { action: 'validation', message: 'startTime has already passed' }
  );
  assert.equal(W.classifyWalkInResult({ kind: 'error', status: 404, data: { message: 'No product' } }).message, 'No product');
  assert.equal(W.classifyWalkInResult({ kind: 'error', status: 400, data: {} }).action, 'validation');
  assert.deepEqual(W.classifyWalkInResult({ kind: 'unauthenticated' }), { action: 'unauthenticated' });
  assert.deepEqual(W.classifyWalkInResult({ kind: 'forbidden' }), { action: 'forbidden' });
  assert.match(W.classifyWalkInResult({ kind: 'network' }).message, /Network error/);
  const serverError = W.classifyWalkInResult({ kind: 'error', status: 500, data: { message: 'Failed to create walk-in booking' } });
  assert.equal(serverError.action, 'error');
});

// ---- duplicate submission -----------------------------------------------------------------
test('submit guard: a second click while the first POST is in flight never sends twice', async () => {
  const guard = W.createSubmitGuard();
  let calls = 0;
  let release;
  const first = guard.run(() => { calls += 1; return new Promise((r) => { release = r; }); });
  assert.equal(guard.busy, true);
  const second = await guard.run(async () => { calls += 1; return 'dup'; });
  assert.equal(second, null);
  release('created');
  assert.equal(await first, 'created');
  assert.equal(calls, 1);
  assert.equal(guard.busy, false);
  // Usable again after completion (e.g. retry after a 409), and released after a throw.
  await assert.rejects(guard.run(async () => { throw new Error('boom'); }));
  assert.equal(guard.busy, false);
  assert.equal(await guard.run(async () => 'again'), 'again');
});

// ---- success formatting -------------------------------------------------------------------
const CREATED = {
  id: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b',
  bookingNumber: 1042,
  bookingSource: 'WALK_IN',
  status: 'confirmed',
  product: { code: 'solo-pro-motion', name: 'Solo Pro', simulatorType: 'motion', racers: 1, durationMinutes: 30 },
  date: '2026-10-01',
  startTime: '18:00',
  endTime: '18:30',
  scheduledStartAt: '2026-10-01T12:30:00.000Z',
  scheduledEndAt: '2026-10-01T13:00:00.000Z',
  priceInr: 1000,
  payment: { method: 'UPI', status: 'paid', amountInr: 1000 },
  simulators: ['M1'],
  customer: { name: 'Asha Rao', phone: '+919876543210', email: null }
};

test('success summary uses Booking #number, never the UUID', () => {
  const s = W.walkInSuccessSummary(CREATED);
  assert.equal(s.reference, 'Booking #1042');
  assert.equal(s.status, 'Confirmed');
  assert.equal(s.packageName, 'Solo Pro');
  assert.equal(s.simulators, 'M1');
  assert.equal(s.paymentMethod, 'UPI');
  assert.equal(s.amountPaid, '₹1,000');
  assert.equal(s.listPrice, null);
  assert.equal(s.startTime, '18:00');
  assert.equal(s.endTime, '18:30');
  assert.doesNotMatch(JSON.stringify(s), /3f2b8c1e/);
});

test('complimentary success shows ₹0 paid plus the list price; multiple simulators are joined', () => {
  const s = W.walkInSuccessSummary({
    ...CREATED,
    priceInr: 3000,
    payment: { method: 'COMPLIMENTARY', status: 'paid', amountInr: 0 },
    simulators: ['S1', 'S2']
  });
  assert.equal(s.paymentMethod, 'Complimentary');
  assert.equal(s.amountPaid, '₹0');
  assert.equal(s.listPrice, '₹3,000');
  assert.equal(s.simulators, 'S1, S2');
});
