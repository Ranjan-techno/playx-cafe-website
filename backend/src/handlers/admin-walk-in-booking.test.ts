import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { listPaymentsForReconciliation } from '../lib/payment-repository';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  findDoubleBookings,
  seedBooking,
  type FakePaymentDbStore,
} from '../lib/test-support/fake-payment-db';
import { createAdminWalkInBookingHandler } from './admin-walk-in-booking';
import { createBookingHandler } from './create-booking';

// Stage 3A.1: POST /admin/bookings/walk-in end-to-end — the real handler + lib/walk-in-booking.ts +
// the shared allocation engine, against the in-memory payment fake (which models transactions with
// an undo journal, the simulators lock, uncommitted-row visibility, and migration 011's CHECKs).

const NOW = new Date('2026-09-29T06:00:00Z'); // Tue 29 Sep 2026, 11:30 IST
const SLOT_START = new Date('2026-09-29T12:30:00Z'); // 18:00 IST
const SLOT_END = new Date('2026-09-29T13:00:00Z');
const ADMIN_SUB = 'admin-sub-1';

afterEach(() => mock.timers.reset());

const BODY = {
  productCode: 'solo-pro-static',
  bookingDate: '2026-09-29',
  startTime: '18:00',
  customer: { name: 'Arun K', phone: '98765 43210', email: null },
  paymentMethod: 'CASH',
  paymentReference: null,
  notes: null,
};

function adminEvent(body: unknown, claims: Record<string, unknown> | null = { sub: ADMIN_SUB, 'cognito:groups': ['admin'] }) {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { authorizer: claims === null ? undefined : { jwt: { claims, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function world(store: FakePaymentDbStore = createFakePaymentDbStore()) {
  mock.timers.enable({ apis: ['Date'], now: NOW });
  const counts = { getDb: 0, resetDb: 0 };
  const clients: ReturnType<typeof createFakePaymentDbClient>[] = [];
  const handler = createAdminWalkInBookingHandler({
    getDb: async () => {
      counts.getDb += 1;
      const client = createFakePaymentDbClient(store);
      clients.push(client);
      return client;
    },
    resetDb: () => {
      counts.resetDb += 1;
    },
    now: () => new Date(),
  });
  return { store, counts, clients, handler };
}

async function call(handler: ReturnType<typeof createAdminWalkInBookingHandler>, event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const res = await handler(event);
  return { statusCode: res.statusCode, body: JSON.parse(String(res.body)) as Record<string, any> };
}

/** Seeds a confirmed booking occupying `simulatorIds` for the 18:00-18:30 slot. */
function occupy(store: FakePaymentDbStore, env: 'SANDBOX' | 'PRODUCTION', simulatorIds: string[], allocationStatus: 'hold' | 'confirmed' = 'confirmed') {
  return seedBooking(store, {
    priceInr: '599.00',
    status: allocationStatus === 'confirmed' ? 'confirmed' : 'pending',
    bookingEnvironment: env,
    allocationStatus,
    simulatorIds,
    holdAllocations: simulatorIds.length,
    start: SLOT_START,
    end: SLOT_END,
    cognitoSub: 'customer-sub',
  });
}

function snapshot(store: FakePaymentDbStore) {
  return { bookings: store.bookings.length, allocations: store.allocations.length, payments: store.payments.length };
}

// ---- authorization ------------------------------------------------------------------------------

test('auth: missing authorizer context -> 401; a signed-in non-admin -> 403; neither touches the DB', async () => {
  const w = world();
  const missing = await call(w.handler, adminEvent(BODY, null));
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.error, 'unauthenticated');
  const noSub = await call(w.handler, adminEvent(BODY, { 'cognito:groups': ['admin'] }));
  assert.equal(noSub.statusCode, 401);
  for (const groups of [undefined, [], ['staff'], 'customers', '[staff]']) {
    const res = await call(w.handler, adminEvent(BODY, { sub: 'customer-sub', 'cognito:groups': groups }));
    assert.equal(res.statusCode, 403, JSON.stringify(groups));
    assert.equal(res.body.error, 'forbidden');
  }
  assert.equal(w.counts.getDb, 0);
  assert.deepEqual(snapshot(w.store), { bookings: 0, allocations: 0, payments: 0 });
});

test('auth: an admin (any claim shape API Gateway produces) is admitted and recorded as created_by_admin_sub', async () => {
  for (const groups of [['admin'], 'admin', '[staff, admin]']) {
    const w = world();
    const res = await call(w.handler, adminEvent(BODY, { sub: 'admin-sub-9', 'cognito:groups': groups }));
    assert.equal(res.statusCode, 201, JSON.stringify(groups));
    assert.equal(w.store.bookings[0].created_by_admin_sub, 'admin-sub-9');
    mock.timers.reset();
  }
});

// ---- creation -----------------------------------------------------------------------------------

test('CASH: 201, confirmed WALK_IN booking in PRODUCTION, confirmed allocation, paid counter payment at list price', async () => {
  const w = world();
  const res = await call(w.handler, adminEvent(BODY));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, {
    id: w.store.bookings[0].id,
    bookingNumber: 1001,
    bookingSource: 'WALK_IN',
    status: 'confirmed',
    product: { code: 'solo-pro-static', name: 'Solo Racing Xperience — Pro Race (Static)', simulatorType: 'static', racers: 1, durationMinutes: 30 },
    date: '2026-09-29',
    startTime: '18:00',
    endTime: '18:30',
    scheduledStartAt: SLOT_START.toISOString(),
    scheduledEndAt: SLOT_END.toISOString(),
    priceInr: 599,
    payment: { method: 'CASH', status: 'paid', amountInr: 599 },
    simulators: ['S1'],
    customer: { name: 'Arun K', phone: '+919876543210', email: null },
  });

  const [booking] = w.store.bookings;
  assert.equal(booking.status, 'confirmed', 'confirmed immediately');
  assert.equal(booking.booking_source, 'WALK_IN');
  assert.equal(booking.booking_environment, 'PRODUCTION');
  assert.equal(booking.cognito_sub, undefined, 'no Cognito sub on a walk-in');
  assert.equal(booking.created_by_admin_sub, ADMIN_SUB);
  assert.equal(booking.price_inr, '599.00');
  assert.equal(booking.customer_phone, '+919876543210');
  assert.equal(booking.customer_email, null);

  assert.equal(w.store.allocations.length, 1);
  assert.equal(w.store.allocations[0].allocation_status, 'confirmed', 'confirmed, never a HOLD');
  assert.equal(w.store.allocations[0].hold_expires_at, null);
  assert.equal(w.store.allocations[0].simulator_id, 'sim-S1');

  assert.equal(w.store.payments.length, 1);
  const [payment] = w.store.payments;
  assert.equal(payment.provider, 'counter');
  assert.equal(payment.payment_method, 'CASH');
  assert.equal(payment.payment_status, 'paid');
  assert.equal(payment.amount_inr, '599.00');
  assert.equal(payment.currency, 'INR');
  assert.equal(payment.payment_environment, 'PRODUCTION');
  assert.ok(payment.paid_at instanceof Date);
  assert.equal(payment.provider_transaction_id, null);
  assert.match(payment.provider_order_id, /^walkin-[0-9a-f-]{36}$/, 'internal, non-PII order id');
  assert.ok(!payment.provider_order_id.includes('9876543210'));

  assert.deepEqual(w.store.notifications, [], 'no BOOKING_CONFIRMED email queued for a walk-in');
  assert.ok(w.clients[0].lockLog.includes('simulators'), 'went through the shared simulators lock');
});

test('UPI and CARD: paid at list price; the optional reference lands in provider_transaction_id', async () => {
  const w = world();
  const upi = await call(w.handler, adminEvent({ ...BODY, paymentMethod: 'UPI', paymentReference: ' UTR412345678901 ' }));
  assert.equal(upi.statusCode, 201);
  assert.deepEqual(upi.body.payment, { method: 'UPI', status: 'paid', amountInr: 599 });
  const card = await call(w.handler, adminEvent({ ...BODY, productCode: 'solo-pro-motion', paymentMethod: 'CARD' }));
  assert.equal(card.statusCode, 201);
  assert.deepEqual(card.body.payment, { method: 'CARD', status: 'paid', amountInr: 999 });
  assert.deepEqual(card.body.simulators, ['M1']);
  const [p1, p2] = w.store.payments;
  assert.equal(p1.payment_method, 'UPI');
  assert.equal(p1.provider_transaction_id, 'UTR412345678901');
  assert.equal(p2.payment_method, 'CARD');
  assert.equal(p2.provider_transaction_id, null, 'card reference optional');
  assert.ok(!JSON.stringify(upi.body).includes('UTR412345678901'), 'the reference is not echoed back');
});

test('COMPLIMENTARY: payment amount 0 and method COMPLIMENTARY, but the booking keeps its list price', async () => {
  const w = world();
  const res = await call(w.handler, adminEvent({ ...BODY, productCode: 'duo-30-motion', paymentMethod: 'COMPLIMENTARY' }));
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.priceInr, 1799);
  assert.deepEqual(res.body.payment, { method: 'COMPLIMENTARY', status: 'paid', amountInr: 0 });
  assert.equal(w.store.bookings[0].price_inr, '1799.00', 'value of the complimentary session stays reportable');
  assert.equal(w.store.payments[0].amount_inr, '0.00');
  assert.equal(w.store.payments[0].payment_method, 'COMPLIMENTARY');
  assert.equal(w.store.payments[0].provider, 'counter');
  assert.equal(w.store.payments[0].metadata?.listPriceInr, '1799.00');
});

test('optional email is stored normalized; notes kept', async () => {
  const w = world();
  const res = await call(
    w.handler,
    adminEvent({ ...BODY, customer: { ...BODY.customer, email: ' Arun@Example.com ' }, notes: ' birthday ' }),
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.customer.email, 'arun@example.com');
  assert.equal(w.store.bookings[0].customer_email, 'arun@example.com');
  assert.equal(w.store.bookings[0].notes, 'birthday');
  assert.deepEqual(w.store.notifications, [], 'an email address alone never queues an email');
});

test('server derives price, duration, racers, simulator requirement, status and environment — client values ignored', async () => {
  const w = world();
  const res = await call(
    w.handler,
    adminEvent({
      ...BODY,
      productCode: 'duo-30-static',
      price: 1,
      priceInr: 1,
      amountInr: 1,
      durationMinutes: 600,
      racers: 1,
      simulators: ['M2'],
      simulatorIds: ['sim-M2'],
      status: 'pending',
      environment: 'SANDBOX',
      bookingEnvironment: 'SANDBOX',
      bookingSource: 'ONLINE',
      cognitoSub: 'victim-sub',
    }),
  );
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.priceInr, 1099);
  assert.equal(res.body.payment.amountInr, 1099);
  assert.equal(res.body.product.durationMinutes, 30);
  assert.equal(res.body.product.racers, 2);
  assert.equal(res.body.endTime, '18:30');
  assert.deepEqual(res.body.simulators, ['S1', 'S2'], 'Duo Static needs both static rigs');
  assert.equal(res.body.status, 'confirmed');
  const [b] = w.store.bookings;
  assert.equal(b.racers, 2);
  assert.equal(b.booking_environment, 'PRODUCTION');
  assert.equal(b.booking_source, 'WALK_IN');
  assert.equal(b.cognito_sub, undefined);
  assert.deepEqual(w.store.allocations.map((a) => a.simulator_id).sort(), ['sim-S1', 'sim-S2']);
});

test('Grand Race takes all four rigs', async () => {
  const w = world();
  const res = await call(w.handler, adminEvent({ ...BODY, productCode: 'grand-race-30', paymentMethod: 'UPI' }));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.simulators, ['S1', 'S2', 'M1', 'M2']);
  assert.equal(res.body.product.simulatorType, null);
});

// ---- validation ---------------------------------------------------------------------------------

test('product must be an active session: unknown 404, inactive 400, race pass 400 — nothing written', async () => {
  const w = world();
  for (const [code, status, error] of [
    ['solo-nope-static', 404, 'product_not_found'],
    ['solo-retired-static', 400, 'product_inactive'],
    ['play-x-race-pass', 400, 'product_not_bookable'],
  ] as const) {
    const res = await call(w.handler, adminEvent({ ...BODY, productCode: code }));
    assert.equal(res.statusCode, status, code);
    assert.equal(res.body.error, error);
  }
  assert.deepEqual(snapshot(w.store), { bookings: 0, allocations: 0, payments: 0 });
});

test('time rules through the handler: off-grid, already-passed, Monday, after hours -> 400, nothing written', async () => {
  const w = world();
  for (const [patch, error] of [
    [{ startTime: '18:10' }, 'invalid_time'],
    [{ startTime: '11:15' }, 'invalid_time'], // NOW is 11:30 IST
    [{ bookingDate: '2026-09-28' }, 'invalid_date'],
    [{ bookingDate: '2026-10-05' }, 'closed'],
    [{ startTime: '22:45' }, 'invalid_time'],
    [{ startTime: '10:30' }, 'invalid_time'],
  ] as const) {
    const res = await call(w.handler, adminEvent({ ...BODY, ...patch }));
    assert.equal(res.statusCode, 400, JSON.stringify(patch));
    assert.equal(res.body.error, error, JSON.stringify(patch));
  }
  assert.deepEqual(snapshot(w.store), { bookings: 0, allocations: 0, payments: 0 });
});

test('malformed body -> 400 invalid_request, before any DB connection', async () => {
  const w = world();
  for (const body of ['not json', { ...BODY, customer: { name: 'A', phone: '1' } }, { ...BODY, paymentMethod: 'PHONEPE' }]) {
    const res = await call(w.handler, adminEvent(body));
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'invalid_request');
  }
  assert.equal(w.counts.getDb, 0);
});

// ---- capacity, atomicity and concurrency --------------------------------------------------------

test('capacity conflict -> 409 capacity_unavailable and the whole transaction rolls back (no booking/allocation/payment)', async () => {
  const w = world();
  occupy(w.store, 'PRODUCTION', ['sim-S1', 'sim-S2']);
  const before = snapshot(w.store);
  const res = await call(w.handler, adminEvent(BODY));
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'capacity_unavailable');
  assert.deepEqual(snapshot(w.store), before, 'nothing survives');
  assert.equal(w.store.uncommittedBookingIds.size, 0);
  assert.equal(w.clients[0].inTransaction(), false);
  // A sequence value is consumed (like Postgres), but no row carries it.
  assert.ok(!w.store.bookings.some((b) => b.booking_source === 'WALK_IN'));
});

test('S1 busy / S2 free: Solo Static -> S2; Duo Static -> 409', async () => {
  const w = world();
  occupy(w.store, 'PRODUCTION', ['sim-S1']);
  const duo = await call(w.handler, adminEvent({ ...BODY, productCode: 'duo-30-static' }));
  assert.equal(duo.statusCode, 409);
  const solo = await call(w.handler, adminEvent(BODY));
  assert.equal(solo.statusCode, 201);
  assert.deepEqual(solo.body.simulators, ['S2']);
});

test('walk-in conflicts with a PRODUCTION online booking — confirmed or still-held', async () => {
  for (const status of ['confirmed', 'hold'] as const) {
    const w = world();
    occupy(w.store, 'PRODUCTION', ['sim-S1', 'sim-S2'], status);
    assert.equal((await call(w.handler, adminEvent(BODY))).statusCode, 409, status);
    mock.timers.reset();
  }
});

test('walk-in does NOT conflict with SANDBOX (staging/test) occupancy', async () => {
  const w = world();
  occupy(w.store, 'SANDBOX', ['sim-S1', 'sim-S2', 'sim-M1', 'sim-M2']);
  const res = await call(w.handler, adminEvent({ ...BODY, productCode: 'grand-race-30' }));
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body.simulators, ['S1', 'S2', 'M1', 'M2']);
});

test('walk-in blocks PRODUCTION online capacity but not SANDBOX; a second walk-in is blocked too', async () => {
  const w = world();
  assert.equal((await call(w.handler, adminEvent(BODY))).statusCode, 201);
  assert.equal((await call(w.handler, adminEvent(BODY))).statusCode, 201);
  assert.equal((await call(w.handler, adminEvent(BODY))).statusCode, 409, 'third static walk-in: both rigs taken');

  const deps = {
    getDb: async (): Promise<DbClient> => createFakePaymentDbClient(w.store),
    resetDb: () => {},
    env: { BOOKING_CREATE_ENABLED: 'true', PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC' },
  };
  const online = {
    productCode: 'solo-pro-static',
    bookingDate: '2026-09-29',
    startTime: '18:15',
    customerName: 'Online Customer',
    customerPhone: '9123456789',
    customerEmail: 'online@example.com',
  };
  const onlineEvent = (sub: string) =>
    ({ body: JSON.stringify(online), requestContext: { authorizer: { jwt: { claims: { sub }, scopes: [] } } } }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const prod = await createBookingHandler('PRODUCTION', deps)(onlineEvent('cust-1'));
  assert.equal(prod.statusCode, 409, 'overlapping PRODUCTION online booking refused');
  const sandbox = await createBookingHandler('SANDBOX', deps)(onlineEvent('cust-2'));
  assert.equal(sandbox.statusCode, 201, 'SANDBOX unaffected by walk-ins');
  // The SANDBOX booking shares rig S1's code with a PRODUCTION walk-in — legitimately, since the
  // environments don't share occupancy — while no rig is double-allocated within an environment.
  const sandboxBooking = w.store.bookings.find((b) => b.booking_environment === 'SANDBOX');
  assert.deepEqual(w.store.allocations.filter((a) => a.booking_id === sandboxBooking?.id).map((a) => a.simulator_id), ['sim-S1']);
  assert.deepEqual(findDoubleBookings(w.store), []);
});

test('concurrent walk-in vs PRODUCTION online booking for the last static rig: exactly one wins, never both', async () => {
  for (let round = 0; round < 6; round += 1) {
    const w = world();
    occupy(w.store, 'PRODUCTION', ['sim-S2']); // only S1 left
    const deps = {
      getDb: async (): Promise<DbClient> => createFakePaymentDbClient(w.store),
      resetDb: () => {},
      env: { BOOKING_CREATE_ENABLED: 'true', PHONEPE_PRODUCTION_ACCESS_MODE: 'PUBLIC' },
    };
    const onlineBody = {
      productCode: 'solo-pro-static',
      bookingDate: '2026-09-29',
      startTime: '18:00',
      customerName: 'Online Customer',
      customerPhone: '9123456789',
      customerEmail: 'online@example.com',
    };
    const onlineCall = () =>
      createBookingHandler('PRODUCTION', deps)({
        body: JSON.stringify(onlineBody),
        requestContext: { authorizer: { jwt: { claims: { sub: 'cust-1' }, scopes: [] } } },
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
    const walkInCall = () => w.handler(adminEvent(BODY));
    const results = round % 2 === 0 ? await Promise.all([walkInCall(), onlineCall()]) : (await Promise.all([onlineCall(), walkInCall()])).reverse();
    const codes = results.map((r) => r.statusCode).sort();
    assert.deepEqual(codes, [201, 409], `round ${round}`);
    assert.deepEqual(findDoubleBookings(w.store), [], `round ${round}: no simulator double-allocated`);
    assert.equal(w.store.allocations.filter((a) => a.simulator_id === 'sim-S1').length, 1);
    if (results[0].statusCode === 409) {
      assert.equal(w.store.payments.length, 0, 'the losing walk-in left no counter payment');
    }
    mock.timers.reset();
  }
});

test('concurrent walk-ins for one rig: one 201, one 409', async () => {
  const w = world();
  occupy(w.store, 'PRODUCTION', ['sim-S2']);
  const results = await Promise.all([w.handler(adminEvent(BODY)), w.handler(adminEvent(BODY))]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.deepEqual(findDoubleBookings(w.store), []);
  assert.equal(w.store.payments.length, 1);
});

test('an unexpected DB failure mid-transaction -> 500, fully rolled back, and nothing sensitive is logged', async () => {
  const store = createFakePaymentDbStore();
  mock.timers.enable({ apis: ['Date'], now: NOW });
  let resets = 0;
  const handler = createAdminWalkInBookingHandler({
    getDb: async () => {
      const inner = createFakePaymentDbClient(store);
      return {
        async query<T extends object>(text: string, params?: unknown[]) {
          if (/^\s*INSERT INTO payments/.test(text)) {
            throw Object.assign(new Error('Failing row contains (+919876543210, UTR999)'), { code: '23514' });
          }
          return inner.query<T>(text, params);
        },
      };
    },
    resetDb: () => {
      resets += 1;
    },
    now: () => new Date(),
  });
  const logged: unknown[][] = [];
  const spy = mock.method(console, 'error', (...args: unknown[]) => {
    logged.push(args);
  });
  try {
    const res = await handler(adminEvent({ ...BODY, paymentMethod: 'UPI', paymentReference: 'UTR999' }));
    assert.equal(res.statusCode, 500);
  } finally {
    spy.mock.restore();
  }
  assert.deepEqual(snapshot(store), { bookings: 0, allocations: 0, payments: 0 });
  assert.equal(resets, 1);
  const text = JSON.stringify(logged);
  assert.ok(!text.includes('9876543210') && !text.includes('UTR999') && !text.includes('Arun'), text);
  assert.match(text, /code=23514/);
});

// ---- PhonePe never processes counter payments ---------------------------------------------------

test('the PhonePe reconciler never selects a counter payment', async () => {
  const w = world();
  assert.equal((await call(w.handler, adminEvent({ ...BODY, paymentMethod: 'UPI' }))).statusCode, 201);
  const db = createFakePaymentDbClient(w.store);
  for (const env of ['PRODUCTION', 'SANDBOX'] as const) {
    assert.deepEqual(await listPaymentsForReconciliation(db, env, 100), []);
  }
  // And the real query itself pins provider = 'phonepe' (not just the fake's emulation of it).
  const texts: string[] = [];
  await listPaymentsForReconciliation(
    {
      async query<T extends object>(text: string) {
        texts.push(text);
        return { rows: [] as T[] };
      },
    },
    'PRODUCTION',
    10,
  );
  assert.match(texts[0], /WHERE provider = 'phonepe'/);
});
