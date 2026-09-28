import assert from 'node:assert/strict';
import { afterEach, test, mock } from 'node:test';
import { counterAmountInr, parseWalkInBody, validateWalkInSchedule, type WalkInRequest } from './walk-in-booking';

// Pure halves of lib/walk-in-booking.ts: request parsing (what the counter may and may not supply)
// and the Stage 3A walk-in time rules. The transactional half is exercised end-to-end through the
// handler in handlers/admin-walk-in-booking.test.ts.

const NOW = new Date('2026-09-29T06:00:00Z'); // Tue 29 Sep 2026, 11:30 IST

afterEach(() => mock.timers.reset());

const BASE = {
  productCode: 'solo-pro-static',
  bookingDate: '2026-09-29',
  startTime: '18:00',
  customer: { name: 'Arun K', phone: '98765 43210', email: null },
  paymentMethod: 'CASH',
  paymentReference: null,
  notes: null,
};

function parse(body: unknown): ReturnType<typeof parseWalkInBody> {
  return parseWalkInBody(JSON.stringify(body));
}

function ok(body: unknown): WalkInRequest {
  const result = parse(body);
  assert.ok(result.ok, result.ok ? '' : result.message);
  return result.value;
}

test('parse: a minimal valid body; phone normalized to +91, email optional, notes optional', () => {
  const value = ok(BASE);
  assert.deepEqual(value, {
    productCode: 'solo-pro-static',
    bookingDate: '2026-09-29',
    startTime: '18:00',
    customer: { name: 'Arun K', phone: '+919876543210', email: null },
    paymentMethod: 'CASH',
    paymentReference: null,
    notes: null,
  });
  // email/reference/notes may be omitted entirely or blank.
  const { paymentReference: _r, notes: _n, ...rest } = BASE;
  assert.equal(ok({ ...rest, customer: { name: 'A', phone: '9876543210' } }).customer.email, null);
  assert.equal(ok({ ...BASE, customer: { ...BASE.customer, email: '   ' } }).customer.email, null);
});

test('parse: a supplied email is trimmed/lower-cased; an invalid one is rejected', () => {
  assert.equal(ok({ ...BASE, customer: { ...BASE.customer, email: '  Arun@Example.COM ' } }).customer.email, 'arun@example.com');
  for (const email of ['nope', 'a@b', 42, {}]) {
    const r = parse({ ...BASE, customer: { ...BASE.customer, email } });
    assert.ok(!r.ok, String(email));
  }
});

test('parse: name and a valid Indian mobile are required', () => {
  for (const customer of [
    undefined,
    null,
    'Arun',
    [],
    { phone: '9876543210' },
    { name: '   ', phone: '9876543210' },
    { name: 'x'.repeat(101), phone: '9876543210' },
    { name: 'Arun' },
    { name: 'Arun', phone: '12345' },
    { name: 'Arun', phone: 9876543210 },
  ]) {
    assert.ok(!parse({ ...BASE, customer }).ok, JSON.stringify(customer));
  }
  assert.equal(ok({ ...BASE, customer: { name: '  Arun  ', phone: '+91 98765-43210' } }).customer.name, 'Arun');
  assert.equal(ok({ ...BASE, customer: { name: 'Arun', phone: '09876543210' } }).customer.phone, '+919876543210');
});

test('parse: paymentMethod must be exactly CASH, UPI, CARD or COMPLIMENTARY', () => {
  for (const m of ['CASH', 'UPI', 'CARD', 'COMPLIMENTARY']) {
    assert.equal(ok({ ...BASE, paymentMethod: m }).paymentMethod, m);
  }
  for (const m of [undefined, null, 'cash', 'PHONEPE', 'counter', 'FREE', 1]) {
    assert.ok(!parse({ ...BASE, paymentMethod: m }).ok, String(m));
  }
});

test('parse: paymentReference is optional, trimmed, bounded, identifier-only, and only for UPI/CARD', () => {
  assert.equal(ok({ ...BASE, paymentMethod: 'UPI', paymentReference: '  UTR 412345678901 ' }).paymentReference, 'UTR 412345678901');
  assert.equal(ok({ ...BASE, paymentMethod: 'CARD', paymentReference: 'slip-0042/A' }).paymentReference, 'slip-0042/A');
  assert.equal(ok({ ...BASE, paymentMethod: 'UPI', paymentReference: '' }).paymentReference, null);
  assert.equal(ok({ ...BASE, paymentMethod: 'CARD' }).paymentReference, null, 'a card payment without a reference is fine');
  assert.ok(!parse({ ...BASE, paymentMethod: 'UPI', paymentReference: 'x'.repeat(65) }).ok, 'too long');
  assert.ok(ok({ ...BASE, paymentMethod: 'UPI', paymentReference: 'x'.repeat(64) }).paymentReference);
  for (const bad of ['<script>', 'a;b', "o'reilly", 'line\nbreak', 12345]) {
    assert.ok(!parse({ ...BASE, paymentMethod: 'UPI', paymentReference: bad }).ok, JSON.stringify(bad));
  }
  assert.ok(!parse({ ...BASE, paymentMethod: 'CASH', paymentReference: 'R1' }).ok, 'no reference for cash');
  assert.ok(!parse({ ...BASE, paymentMethod: 'COMPLIMENTARY', paymentReference: 'R1' }).ok, 'no reference for complimentary');
});

test('parse: productCode/bookingDate/startTime shapes; notes bounded; non-object bodies rejected', () => {
  for (const patch of [
    { productCode: '' },
    { productCode: 'solo pro' },
    { bookingDate: '29-09-2026' },
    { startTime: '6pm' },
    { startTime: '18:0' },
    { notes: 'x'.repeat(501) },
    { notes: 5 },
  ]) {
    assert.ok(!parse({ ...BASE, ...patch }).ok, JSON.stringify(patch));
  }
  assert.equal(ok({ ...BASE, notes: '  birthday  ' }).notes, 'birthday');
  for (const raw of [undefined, '', 'not json', '[]', 'null', '42']) {
    assert.equal(parseWalkInBody(raw).ok, false, String(raw));
  }
});

test('parse: client-supplied price/amount/duration/racers/simulators/status/environment are never read', () => {
  const value = ok({
    ...BASE,
    price: 1,
    priceInr: 1,
    amountInr: 0,
    amount: 0,
    durationMinutes: 600,
    racers: 4,
    simulatorIds: ['M2'],
    simulators: ['M2'],
    status: 'pending',
    bookingStatus: 'cancelled',
    environment: 'SANDBOX',
    bookingEnvironment: 'SANDBOX',
    bookingSource: 'ONLINE',
    cognitoSub: 'someone',
    createdByAdminSub: 'someone-else',
  });
  assert.deepEqual(Object.keys(value).sort(), ['bookingDate', 'customer', 'notes', 'paymentMethod', 'paymentReference', 'productCode', 'startTime']);
  assert.deepEqual(Object.keys(value.customer).sort(), ['email', 'name', 'phone']);
});

test('time rules: 15-minute grid enforced', () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  for (const t of ['18:00', '18:15', '18:30', '18:45']) {
    assert.equal(validateWalkInSchedule('2026-09-29', t, 30, NOW), null, t);
  }
  for (const t of ['18:05', '18:10', '18:20', '18:59']) {
    assert.equal(validateWalkInSchedule('2026-09-29', t, 30, NOW)?.code, 'invalid_time', t);
  }
});

test('time rules: a start time already past today is rejected; later today and future days are fine', () => {
  mock.timers.enable({ apis: ['Date'], now: NOW }); // 11:30 IST
  assert.equal(validateWalkInSchedule('2026-09-29', '11:15', 30, NOW)?.code, 'invalid_time');
  assert.match(validateWalkInSchedule('2026-09-29', '11:15', 30, NOW)?.message ?? '', /already passed/);
  assert.equal(validateWalkInSchedule('2026-09-29', '11:30', 30, NOW), null, 'starting exactly now is allowed');
  assert.equal(validateWalkInSchedule('2026-09-29', '11:45', 30, NOW), null);
  assert.equal(validateWalkInSchedule('2026-10-06', '11:00', 30, NOW), null);
});

test('time rules: the online opening-hours rules are reused unchanged', () => {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  assert.equal(validateWalkInSchedule('2026-09-28', '18:00', 30, NOW)?.code, 'invalid_date', 'yesterday');
  assert.equal(validateWalkInSchedule('2026-10-05', '18:00', 30, NOW)?.code, 'closed', 'a Monday');
  assert.equal(validateWalkInSchedule('2026-09-30', '10:45', 30, NOW)?.code, 'invalid_time', 'before 11:00');
  assert.equal(validateWalkInSchedule('2026-09-30', '22:45', 30, NOW)?.code, 'invalid_time', 'would end after 23:00');
  assert.equal(validateWalkInSchedule('2026-09-30', '22:30', 30, NOW), null, 'ends exactly at 23:00');
  assert.equal(validateWalkInSchedule('2026-09-30', '22:30', 60, NOW)?.code, 'invalid_time', 'a 60-minute session must also finish by 23:00');
  assert.equal(validateWalkInSchedule('2026-02-30', '18:00', 30, NOW)?.code, 'invalid_date');
});

test('counter amount: list price for CASH/UPI/CARD, 0.00 for COMPLIMENTARY', () => {
  assert.equal(counterAmountInr('CASH', '599.00'), '599.00');
  assert.equal(counterAmountInr('UPI', '599.00'), '599.00');
  assert.equal(counterAmountInr('CARD', '1799.00'), '1799.00');
  assert.equal(counterAmountInr('COMPLIMENTARY', '599.00'), '0.00');
});
