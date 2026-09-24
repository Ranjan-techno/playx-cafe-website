import { afterEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { createFakeDbClient, createFakeDbStore, type FakeDbStore } from '../lib/test-support/fake-db';
import {
  BOOKING_ENVIRONMENT,
  createBookingHandler,
  insertPendingBooking,
  parseBody,
  type PendingBookingInsert,
} from './create-booking';

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

test('server-controlled fields: a client-supplied bookingNumber is silently dropped, not stored', () => {
  // bookingNumber is server/database-generated (bookings.booking_number's DEFAULT
  // nextval('booking_number_seq') — see database/migrations/004_short_booking_number.sql). parseBody
  // has no notion of it at all: the handler's INSERT never reads a bookingNumber field off the
  // request, so a client stuffing one into the body must have zero effect on what gets stored.
  const result = parseBody(rawBody({ bookingNumber: 9999, booking_number: 1 }));
  assert.ok(result);
  assert.equal('bookingNumber' in result, false);
  assert.equal('booking_number' in result, false);
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

// ----------------------------------------------------------------------------
// bookings.booking_environment (typed column, migration 006)
// ----------------------------------------------------------------------------

const INSERT_VALUES: PendingBookingInsert = {
  productId: 'prod-1',
  cognitoSub: 'sub-1',
  customerName: 'Priya Sharma',
  customerPhone: '+919876543210',
  customerEmail: 'priya@example.com',
  racers: 1,
  durationMinutes: 30,
  simulatorType: 'static',
  priceInr: '999.00',
  scheduledStartAt: new Date('2026-09-26T12:30:00Z'),
  scheduledEndAt: new Date('2026-09-26T13:00:00Z'),
  notes: null,
};

function recordingDb() {
  const calls: { text: string; params: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [{ id: 'b-1', booking_number: 1001 }] };
    },
  };
}

test('booking environment: the deployed POST /bookings writes the server-side SANDBOX constant', () => {
  assert.equal(BOOKING_ENVIRONMENT, 'SANDBOX');
});

test('booking environment: the INSERT explicitly lists booking_environment and binds the backend value', async () => {
  const db = recordingDb();
  const row = await insertPendingBooking(db as never, INSERT_VALUES, BOOKING_ENVIRONMENT);
  assert.deepEqual(row, { id: 'b-1', booking_number: 1001 });
  assert.equal(db.calls.length, 1);
  const { text, params } = db.calls[0];
  assert.match(text, /scheduled_start_at, scheduled_end_at, notes, booking_environment\)/);
  assert.match(text, /\$10, \$11, \$12, \$13\)/);
  assert.equal(params.length, 13);
  assert.equal(params[12], 'SANDBOX');
  assert.match(text, /'pending'/, 'status stays a literal');
});

test('booking environment: a missing/unknown environment throws before any SQL', async () => {
  const db = recordingDb();
  for (const env of [undefined, null, '', 'sandbox', 'LIVE']) {
    await assert.rejects(() => insertPendingBooking(db as never, INSERT_VALUES, env as never), /bookingEnvironment must be SANDBOX or PRODUCTION/);
  }
  assert.equal(db.calls.length, 0);
});

test('booking environment: the request body cannot choose it (parseBody never reads or returns it)', () => {
  for (const extra of [
    { booking_environment: 'PRODUCTION' },
    { bookingEnvironment: 'PRODUCTION' },
    { environment: 'PRODUCTION' },
    { paymentEnvironment: 'PRODUCTION' },
  ]) {
    const result = parseBody(rawBody(extra));
    assert.ok(result, 'extra keys are ignored, not rejected');
    assert.deepEqual(Object.keys(result).sort(), ['customerEmail', 'customerName', 'customerPhone', 'bookingDate', 'notes', 'productCode', 'startTime'].sort());
    assert.ok(!JSON.stringify(result).includes('PRODUCTION'));
  }
});

test('booking environment: the SANDBOX handler passes BOOKING_ENVIRONMENT, the production entry a PRODUCTION literal; nothing derived from the request', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require.resolve('./create-booking.ts'), 'utf8') as string;
  assert.match(src, /^export const handler = createBookingHandler\(BOOKING_ENVIRONMENT\);$/m);
  const factorySrc = src.slice(src.indexOf('export function createBookingHandler'));
  assert.match(factorySrc, /insertPendingBooking\([\s\S]*?environment,\s*\)/);
  assert.doesNotMatch(src, /body\.(booking_?[eE]nvironment|environment)/);
  assert.doesNotMatch(src, /event\.headers|domainName|requestContext\.http/, 'no Origin/Host-based decision');

  const prodSrc = fs.readFileSync(require.resolve('./create-booking-production.ts'), 'utf8') as string;
  assert.match(prodSrc, /^export const handler = createBookingHandler\('PRODUCTION'\);$/m);
  const prodCode = prodSrc
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  assert.doesNotMatch(prodCode, /event|process\.env|phonepe/i, 'a thin wrapper: no request, env or PhonePe dependency');
});

// ----------------------------------------------------------------------------
// Whole handler: SANDBOX (POST /bookings) vs PRODUCTION (POST /bookings/production)
// ----------------------------------------------------------------------------

// Thursday 1 Oct 2026, 18:00 IST — well inside opening hours, after the Grand Opening.
const NOW = Date.UTC(2026, 8, 24, 6, 0, 0);
const HANDLER_BODY = { ...VALID_FIELDS, bookingDate: '2026-10-01', startTime: '18:00' };

afterEach(() => mock.timers.reset());

interface HandlerWorld {
  store: FakeDbStore;
  inserts: unknown[][];
  sandbox: ReturnType<typeof createBookingHandler>;
  production: ReturnType<typeof createBookingHandler>;
}

/** Both handlers over ONE shared fake database with a single static rig, so capacity is shared
 *  exactly as the real deployment shares simulator inventory between the two environments. The
 *  products lookup and booking INSERT are answered here (recording the INSERT's params); simulator
 *  locking/allocation goes to the real allocateSimulators() via test-support/fake-db.ts. */
function handlerWorld(): HandlerWorld {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = createFakeDbStore([{ id: 's1', code: 'S1', simulator_type: 'static' }]);
  const inserts: unknown[][] = [];
  let bookingNumber = 1000;
  const getDb = async (): Promise<DbClient> => {
    const inner = createFakeDbClient(store);
    return {
      async query<T extends object>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
        if (/FROM products/i.test(text)) {
          const rows = [
            {
              id: 'prod-solo-static',
              product_type: 'session',
              simulator_type: 'static',
              racers: 1,
              duration_minutes: 30,
              price_inr: '999.00',
              is_active: true,
            },
          ];
          return { rows: rows as unknown as T[] };
        }
        if (/^\s*INSERT INTO bookings/i.test(text)) {
          inserts.push(params);
          bookingNumber += 1;
          const id = `booking-${bookingNumber}`;
          store.bookings.push({ id });
          return { rows: [{ id, booking_number: bookingNumber }] as unknown as T[] };
        }
        return inner.query<T>(text, params);
      },
    };
  };
  // Both subs used below are on the Stage 2C production tester allowlist.
  const deps = { getDb, resetDb: () => {}, env: { BOOKING_CREATE_ENABLED: 'true', PHONEPE_PRODUCTION_TESTERS: 'sub-1,sub-2' } };
  return {
    store,
    inserts,
    sandbox: createBookingHandler('SANDBOX', deps),
    production: createBookingHandler('PRODUCTION', deps),
  };
}

function bookingEvent(body: unknown, sub = 'sub-1'): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    body: JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

async function invoke(handler: ReturnType<typeof createBookingHandler>, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const res = await handler(event);
  return { statusCode: res.statusCode, body: JSON.parse(String(res.body)) as Record<string, unknown> };
}

test('handler: POST /bookings (SANDBOX handler) writes booking_environment=SANDBOX', async () => {
  const w = handlerWorld();
  const res = await invoke(w.sandbox, bookingEvent(HANDLER_BODY));
  assert.equal(res.statusCode, 201);
  assert.equal(w.inserts.length, 1);
  assert.equal(w.inserts[0][12], 'SANDBOX');
});

test('handler: POST /bookings/production (PRODUCTION handler) writes booking_environment=PRODUCTION', async () => {
  const w = handlerWorld();
  const res = await invoke(w.production, bookingEvent(HANDLER_BODY));
  assert.equal(res.statusCode, 201);
  assert.equal(w.inserts.length, 1);
  assert.equal(w.inserts[0][12], 'PRODUCTION');
  // Same response shape as the sandbox route; no environment echoed back.
  assert.deepEqual(Object.keys(res.body).sort(), ['bookingNumber', 'date', 'holdExpiresAt', 'id', 'price', 'product', 'status', 'time']);
  assert.equal(res.body.price, 999, 'price from the products table');
  assert.ok(!JSON.stringify(res.body).includes('PRODUCTION'));
});

test('handler: the request body cannot override either environment', async () => {
  const overrides = {
    booking_environment: 'X',
    bookingEnvironment: 'X',
    environment: 'X',
    paymentEnvironment: 'X',
  };
  for (const [route, claimed, expected] of [
    ['sandbox', 'PRODUCTION', 'SANDBOX'],
    ['production', 'SANDBOX', 'PRODUCTION'],
  ] as const) {
    const w = handlerWorld();
    const body = { ...HANDLER_BODY, ...Object.fromEntries(Object.keys(overrides).map((k) => [k, claimed])) };
    const res = await invoke(w[route], bookingEvent(body));
    assert.equal(res.statusCode, 201, route);
    assert.equal(w.inserts[0][12], expected, `${route} route ignores a body claiming ${claimed}`);
    mock.timers.reset();
  }
});

test('handler: both environments share the same capacity/allocation logic and the same inventory', async () => {
  // A PRODUCTION booking takes the only static rig -> a SANDBOX booking for the same slot is 409.
  const a = handlerWorld();
  assert.equal((await invoke(a.production, bookingEvent(HANDLER_BODY))).statusCode, 201);
  const clash = await invoke(a.sandbox, bookingEvent(HANDLER_BODY, 'sub-2'));
  assert.equal(clash.statusCode, 409);
  assert.equal(clash.body.error, 'simulator_unavailable');
  assert.equal(a.store.allocations.length, 1);
  mock.timers.reset();

  // And the reverse, plus a second PRODUCTION booking is also refused.
  const b = handlerWorld();
  assert.equal((await invoke(b.sandbox, bookingEvent(HANDLER_BODY))).statusCode, 201);
  assert.equal((await invoke(b.production, bookingEvent(HANDLER_BODY, 'sub-2'))).statusCode, 409);
  assert.equal((await invoke(b.production, bookingEvent({ ...HANDLER_BODY, startTime: '19:00' }, 'sub-2'))).statusCode, 201, 'a free slot still books');
  assert.equal(b.store.allocations.length, 2);
});

test('handler: same validation/schedule rules on the production route (bad body 400, Monday closed)', async () => {
  const w = handlerWorld();
  assert.equal((await invoke(w.production, bookingEvent({ ...HANDLER_BODY, customerPhone: 'nope' }))).statusCode, 400);
  const monday = await invoke(w.production, bookingEvent({ ...HANDLER_BODY, bookingDate: '2026-09-28' }));
  assert.equal(monday.statusCode, 400);
  assert.equal(monday.body.error, 'closed');
  assert.equal(w.inserts.length, 0);
});

test('handler factory: an unknown environment fails at construction, never per request', () => {
  for (const env of [undefined, '', 'sandbox', 'LIVE']) {
    assert.throws(() => createBookingHandler(env as never), /bookingEnvironment must be SANDBOX or PRODUCTION/);
  }
});

// ----------------------------------------------------------------------------
// BOOKING_CREATE_ENABLED kill switch
// ----------------------------------------------------------------------------

/** A production-style handler whose DB seam counts every connection and query. */
function killSwitchBookingWorld(
  bookingCreateEnabled: string | undefined,
  environment: 'SANDBOX' | 'PRODUCTION' = 'PRODUCTION',
  productionTesters?: string,
  productionAccessMode?: string,
) {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const store = createFakeDbStore([{ id: 's1', code: 'S1', simulator_type: 'static' }]);
  const calls = { getDb: 0, resetDb: 0, queries: [] as string[], bookingEnvironments: [] as unknown[] };
  const handler = createBookingHandler(environment, {
    getDb: async () => {
      calls.getDb += 1;
      const inner = createFakeDbClient(store);
      return {
        async query<T extends object>(text: string, params: unknown[] = []) {
          calls.queries.push(text);
          if (/INSERT INTO bookings/i.test(text)) calls.bookingEnvironments.push(params[12]);
          if (/FROM products/i.test(text)) {
            const rows = [
              { id: 'prod-solo-static', product_type: 'session', simulator_type: 'static', racers: 1, duration_minutes: 30, price_inr: '999.00', is_active: true },
            ];
            return { rows: rows as unknown as T[] };
          }
          return inner.query<T>(text, params);
        },
      };
    },
    resetDb: () => {
      calls.resetDb += 1;
    },
    env: {
      BOOKING_CREATE_ENABLED: bookingCreateEnabled,
      PHONEPE_PRODUCTION_TESTERS: productionTesters,
      PHONEPE_PRODUCTION_ACCESS_MODE: productionAccessMode,
    },
  });
  return { store, calls, handler };
}

test('booking kill switch: BOOKING_CREATE_ENABLED=false -> generic 503, no DB connection, no INSERT, no allocation', async () => {
  const w = killSwitchBookingWorld('false');
  const res = await w.handler(bookingEvent(HANDLER_BODY));
  assert.equal(res.statusCode, 503);
  assert.deepEqual(JSON.parse(String(res.body)), {
    error: 'bookings_temporarily_unavailable',
    message: 'Online booking is temporarily unavailable',
  });
  assert.ok(!/SANDBOX|PRODUCTION|environment/i.test(String(res.body)), 'no environment detail exposed');
  assert.equal(w.calls.getDb, 0, 'getDb never called');
  assert.equal(w.calls.resetDb, 0);
  assert.deepEqual(w.calls.queries, [], 'no SQL at all, so no INSERT');
  assert.equal(w.store.bookings.length, 0);
  assert.equal(w.store.allocations.length, 0, 'no inventory hold');
});

test('booking kill switch: missing / malformed values are all disabled (fail closed), for either environment', async () => {
  for (const environment of ['PRODUCTION', 'SANDBOX'] as const) {
    for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'enabled']) {
      const w = killSwitchBookingWorld(value, environment);
      const res = await w.handler(bookingEvent(HANDLER_BODY));
      assert.equal(res.statusCode, 503, `${environment} ${JSON.stringify(value)}`);
      assert.equal(w.calls.getDb, 0);
      assert.equal(w.store.allocations.length, 0);
      mock.timers.reset();
    }
  }
});

test('booking kill switch: the request body cannot override the switch; disabled wins over bad input too', async () => {
  const w = killSwitchBookingWorld('false');
  for (const body of [
    { ...HANDLER_BODY, BOOKING_CREATE_ENABLED: 'true', bookingCreateEnabled: true, enabled: 'true', environment: 'SANDBOX' },
    { nonsense: true },
  ]) {
    const res = await w.handler(bookingEvent(body));
    assert.equal(res.statusCode, 503);
  }
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.store.bookings.length, 0);
});

test('booking kill switch: exact "true" keeps the existing booking happy path unchanged', async () => {
  const w = killSwitchBookingWorld('true', 'SANDBOX');
  const res = await w.handler(bookingEvent(HANDLER_BODY));
  assert.equal(res.statusCode, 201);
  assert.equal(w.calls.getDb, 1);
  assert.equal(w.store.allocations.length, 1, 'normal hold allocated');
  assert.ok(w.calls.queries.some((q) => /INSERT INTO bookings/.test(q)));
});

// ----------------------------------------------------------------------------
// PhonePe cutover Stage 2C: PRODUCTION tester allowlist (PHONEPE_PRODUCTION_TESTERS)
// ----------------------------------------------------------------------------

test('production tester gate: BOOKING_CREATE_ENABLED=false -> 503 before the gate, for listed and unlisted subs', async () => {
  for (const sub of ['sub-1', 'sub-stranger']) {
    const w = killSwitchBookingWorld('false', 'PRODUCTION', 'sub-1');
    const res = await w.handler(bookingEvent(HANDLER_BODY, sub));
    assert.equal(res.statusCode, 503);
    assert.equal(w.calls.getDb, 0);
    mock.timers.reset();
  }
});

test('production tester gate: switch on + missing/empty tester list -> 403 for everyone, no DB, no INSERT, no hold', async () => {
  for (const testers of [undefined, '', '   ', ' , ']) {
    const w = killSwitchBookingWorld('true', 'PRODUCTION', testers);
    const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-1'));
    assert.equal(res.statusCode, 403, JSON.stringify(testers));
    assert.deepEqual(JSON.parse(String(res.body)), {
      error: 'bookings_not_permitted',
      message: 'Online booking is not available for this account',
    });
    assert.equal(w.calls.getDb, 0);
    assert.deepEqual(w.calls.queries, []);
    assert.equal(w.store.allocations.length, 0);
    mock.timers.reset();
  }
});

test('production tester gate: switch on + non-allowlisted sub -> 403; a body claiming another sub/tester status changes nothing', async () => {
  const w = killSwitchBookingWorld('true', 'PRODUCTION', 'sub-1, sub-2');
  const body = { ...HANDLER_BODY, sub: 'sub-1', cognitoSub: 'sub-1', tester: true, PHONEPE_PRODUCTION_TESTERS: 'sub-3' };
  for (const sub of ['sub-3', 'SUB-1', 'sub-1 ']) {
    const res = await w.handler(bookingEvent(body, sub));
    assert.equal(res.statusCode, 403, sub);
    assert.ok(!/PRODUCTION|tester|allowlist/i.test(String(res.body)), 'nothing about the gate is revealed');
  }
  assert.equal(w.calls.getDb, 0);
  assert.equal(w.store.bookings.length, 0);
});

test('production tester gate: switch on + allowlisted sub -> reaches the normal booking logic (PRODUCTION booking + hold)', async () => {
  const w = killSwitchBookingWorld('true', 'PRODUCTION', 'sub-other, sub-1');
  const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-1'));
  assert.equal(res.statusCode, 201);
  assert.equal(w.calls.getDb, 1);
  assert.equal(w.store.allocations.length, 1);
  const insert = w.calls.queries.find((q) => /INSERT INTO bookings/.test(q));
  assert.ok(insert);
  // ...and normal validation still applies to an allowlisted tester.
  assert.equal((await w.handler(bookingEvent({ ...HANDLER_BODY, customerPhone: 'nope' }, 'sub-1'))).statusCode, 400);
});

test('production tester gate: SANDBOX booking is unchanged — no tester list needed, and the production list is ignored', async () => {
  for (const testers of [undefined, '', 'sub-somebody-else']) {
    const w = killSwitchBookingWorld('true', 'SANDBOX', testers);
    const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-anyone'));
    assert.equal(res.statusCode, 201, JSON.stringify(testers));
    mock.timers.reset();
  }
});

// ----------------------------------------------------------------------------
// Stage 2E: explicit production access mode (PHONEPE_PRODUCTION_ACCESS_MODE)
// ----------------------------------------------------------------------------

test('production access mode: missing / unknown / non-exact values behave as TESTER (empty list -> 403 for everyone)', async () => {
  for (const mode of [undefined, '', 'TESTER', 'public', 'Public', ' PUBLIC', 'PUBLIC ', 'OPEN', 'true']) {
    const w = killSwitchBookingWorld('true', 'PRODUCTION', '', mode);
    const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-anyone'));
    assert.equal(res.statusCode, 403, JSON.stringify(mode));
    assert.equal(w.calls.getDb, 0, 'no DB before the gate');
    assert.equal(w.store.allocations.length, 0);
    mock.timers.reset();
  }
});

test('production access mode: TESTER keeps the allowlist mandatory (listed -> 201, unlisted -> 403 before the DB)', async () => {
  const listed = killSwitchBookingWorld('true', 'PRODUCTION', 'sub-1', 'TESTER');
  assert.equal((await listed.handler(bookingEvent(HANDLER_BODY, 'sub-1'))).statusCode, 201);
  mock.timers.reset();
  const unlisted = killSwitchBookingWorld('true', 'PRODUCTION', 'sub-1', 'TESTER');
  assert.equal((await unlisted.handler(bookingEvent(HANDLER_BODY, 'sub-2'))).statusCode, 403);
  assert.equal(unlisted.calls.getDb, 0);
});

test('production access mode: PUBLIC admits any authenticated customer, with or without a tester list', async () => {
  for (const testers of [undefined, '', 'sub-somebody-else']) {
    const w = killSwitchBookingWorld('true', 'PRODUCTION', testers, 'PUBLIC');
    const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-customer'));
    assert.equal(res.statusCode, 201, JSON.stringify(testers));
    assert.ok(w.calls.queries.some((q) => /INSERT INTO bookings/.test(q)));
    assert.deepEqual(w.calls.bookingEnvironments, ['PRODUCTION'], 'environment stays hard-coded PRODUCTION');
    mock.timers.reset();
  }
});

test('production access mode: PUBLIC still requires a verified subject, validation and the kill switch', async () => {
  const w = killSwitchBookingWorld('true', 'PRODUCTION', '', 'PUBLIC');
  const noSub = await w.handler({ ...bookingEvent(HANDLER_BODY, 'x'), requestContext: { authorizer: { jwt: { claims: {} } } } } as never);
  assert.equal(noSub.statusCode, 401);
  assert.equal((await w.handler(bookingEvent({ ...HANDLER_BODY, customerPhone: 'nope' }, 'sub-customer'))).statusCode, 400);
  mock.timers.reset();
  const off = killSwitchBookingWorld('false', 'PRODUCTION', '', 'PUBLIC');
  assert.equal((await off.handler(bookingEvent(HANDLER_BODY, 'sub-customer'))).statusCode, 503);
  assert.equal(off.calls.getDb, 0);
});

test('production access mode: a request body cannot switch the mode or the environment', async () => {
  const w = killSwitchBookingWorld('true', 'PRODUCTION', '', 'TESTER');
  const body = { ...HANDLER_BODY, PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC', accessMode: 'PUBLIC', environment: 'SANDBOX' };
  assert.equal((await w.handler(bookingEvent(body, 'sub-customer'))).statusCode, 403);
  mock.timers.reset();
  const pub = killSwitchBookingWorld('true', 'PRODUCTION', '', 'PUBLIC');
  assert.equal((await pub.handler(bookingEvent(body, 'sub-customer'))).statusCode, 201);
  assert.deepEqual(pub.calls.bookingEnvironments, ['PRODUCTION']);
});

test('production access mode: SANDBOX bookings ignore the production mode entirely', async () => {
  for (const mode of [undefined, 'TESTER', 'PUBLIC']) {
    const w = killSwitchBookingWorld('true', 'SANDBOX', '', mode);
    const res = await w.handler(bookingEvent(HANDLER_BODY, 'sub-anyone'));
    assert.equal(res.statusCode, 201, JSON.stringify(mode));
    assert.deepEqual(w.calls.bookingEnvironments, ['SANDBOX']);
    mock.timers.reset();
  }
});
