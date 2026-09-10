import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBody } from './create-booking';

// POST /bookings request-body validation. This is the only AWS/DB-free logic in the handler (see
// parseBody's export comment in create-booking.ts) — everything downstream of it (product lookup,
// price, schedule validation, the INSERT itself) needs a real/mocked Postgres connection and isn't
// covered here, matching how auth-define-challenge.test.ts/auth-verify-challenge.test.ts only unit
// test the AWS-call-free parts of their handlers.

const VALID_FIELDS = {
  productCode: 'solo-pro-static',
  bookingDate: '2026-09-10',
  startTime: '18:00',
  customerName: 'Priya Sharma',
  customerPhone: '9876543210',
  customerEmail: 'Priya.Sharma@Example.com',
  notes: 'Birthday party',
};

function rawBody(overrides: Record<string, unknown> = {}, omit: string[] = []): string {
  const fields: Record<string, unknown> = { ...VALID_FIELDS, ...overrides };
  for (const key of omit) {
    delete fields[key];
  }
  return JSON.stringify(fields);
}

test('valid contact details: parses and normalizes phone/email, trims notes', () => {
  const result = parseBody(rawBody());
  assert.deepEqual(result, {
    productCode: 'solo-pro-static',
    bookingDate: '2026-09-10',
    startTime: '18:00',
    customerName: 'Priya Sharma',
    customerPhone: '+919876543210',
    customerEmail: 'priya.sharma@example.com',
    notes: 'Birthday party',
  });
});

test('valid contact details: notes is optional and omitting it stores null', () => {
  const result = parseBody(rawBody({}, ['notes']));
  assert.equal(result?.notes, null);
});

test('valid contact details: whitespace-only notes normalizes to null', () => {
  const result = parseBody(rawBody({ notes: '   ' }));
  assert.equal(result?.notes, null);
});

test('missing name: absent customerName is rejected', () => {
  assert.equal(parseBody(rawBody({}, ['customerName'])), null);
});

test('missing name: empty/whitespace-only customerName is rejected', () => {
  assert.equal(parseBody(rawBody({ customerName: '' })), null);
  assert.equal(parseBody(rawBody({ customerName: '   ' })), null);
});

test('missing name: customerName over the max length is rejected', () => {
  assert.equal(parseBody(rawBody({ customerName: 'a'.repeat(101) })), null);
});

test('invalid phone: too few digits is rejected', () => {
  assert.equal(parseBody(rawBody({ customerPhone: '98765432' })), null);
});

test('invalid phone: non-Indian/garbage phone is rejected', () => {
  assert.equal(parseBody(rawBody({ customerPhone: '+1-555-0100' })), null);
  assert.equal(parseBody(rawBody({ customerPhone: 'not-a-phone' })), null);
});

test('invalid phone: accepts the 0-prefixed and 91-prefixed forms the frontend may send', () => {
  assert.equal(parseBody(rawBody({ customerPhone: '09876543210' }))?.customerPhone, '+919876543210');
  assert.equal(parseBody(rawBody({ customerPhone: '919876543210' }))?.customerPhone, '+919876543210');
});

test('invalid email: missing "@" is rejected', () => {
  assert.equal(parseBody(rawBody({ customerEmail: 'not-an-email' })), null);
});

test('invalid email: missing domain is rejected', () => {
  assert.equal(parseBody(rawBody({ customerEmail: 'guest@' })), null);
});

test('ownership: parseBody has no notion of cognitoSub/userId — booking ownership can only come from the JWT', () => {
  const result = parseBody(rawBody({ cognitoSub: 'attacker-controlled-sub', userId: 'attacker-controlled-id' }));
  assert.ok(result);
  assert.equal('cognitoSub' in result, false);
  assert.equal('userId' in result, false);
});

test('server-controlled fields: price/status supplied in the body are silently dropped, not stored', () => {
  const result = parseBody(rawBody({ price: 1, price_inr: 999999, status: 'confirmed' }));
  assert.ok(result);
  assert.equal('price' in result, false);
  assert.equal('price_inr' in result, false);
  assert.equal('status' in result, false);
});

test('server-controlled fields: a client-supplied simulator/rig id is silently dropped, not stored', () => {
  // parseBody has no notion of a simulator at all — which physical rig(s) a booking gets is
  // decided entirely server-side by lib/allocate-simulators.ts, after parseBody returns. A client
  // stuffing one of these into the body must have zero effect.
  const result = parseBody(rawBody({ simulatorId: 'm1', simulator: 'M1', rigId: 'attacker-chosen' }));
  assert.ok(result);
  assert.equal('simulatorId' in result, false);
  assert.equal('simulator' in result, false);
  assert.equal('rigId' in result, false);
});

test('rejects a missing body entirely', () => {
  assert.equal(parseBody(undefined), null);
});

test('rejects malformed JSON', () => {
  assert.equal(parseBody('{not json'), null);
});
