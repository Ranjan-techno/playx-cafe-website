import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocateSimulators, loadBlockingAllocations, loadLegacyBookingWindows, type DbClient } from './allocate-simulators';
import { getSimulatorBoard, SIMULATOR_BOARD_ENVIRONMENT } from './admin-repository';
import { secureBookingCapacity } from './booking-capacity';
import { lockBookingForPayment } from './payment-repository';
import type { SimulatorRow } from './simulator-allocation';
import { createFakeDbClient, createFakeDbStore } from './test-support/fake-db';
import { createFakePaymentDbClient, createFakePaymentDbStore, findDoubleBookings, seedBooking } from './test-support/fake-payment-db';
import { createAvailabilityHandler } from '../handlers/availability';

// Stage 3A.1: SANDBOX (staging/test) and PRODUCTION (live online + walk-in) bookings share the
// physical rig codes S1/S2/M1/M2 and the one simulators lock, but never each other's occupancy.
// Everything below drives the REAL allocateSimulators / secureBookingCapacity / availability /
// simulator-board code against the in-memory fakes.

const SIMULATORS: SimulatorRow[] = [
  { id: 's1', code: 'S1', simulator_type: 'static' },
  { id: 's2', code: 'S2', simulator_type: 'static' },
  { id: 'm1', code: 'M1', simulator_type: 'motion' },
  { id: 'm2', code: 'M2', simulator_type: 'motion' },
];
const ONE_STATIC: SimulatorRow[] = [{ id: 's1', code: 'S1', simulator_type: 'static' }];

const START = new Date('2026-10-06T12:30:00Z'); // 18:00 IST, a Tuesday
const END = new Date('2026-10-06T13:00:00Z');

async function book(
  db: ReturnType<typeof createFakeDbClient>,
  environment: 'SANDBOX' | 'PRODUCTION',
  requirement = { static: 1, motion: 0 },
): Promise<string[] | null> {
  await db.query('BEGIN');
  const { rows } = await db.query<{ id: string }>('INSERT INTO bookings (booking_environment) VALUES ($1) RETURNING id', [environment]);
  const result = await allocateSimulators(db, {
    bookingId: rows[0].id,
    requirement,
    scheduledStartAt: START,
    scheduledEndAt: END,
    holdMinutes: 15,
    environment,
  });
  await db.query(result ? 'COMMIT' : 'ROLLBACK');
  return result ? result.simulatorIds : null;
}

test('1. a SANDBOX allocation does not block PRODUCTION (same physical rig code)', async () => {
  const store = createFakeDbStore(ONE_STATIC);
  const db = createFakeDbClient(store);
  assert.deepEqual(await book(db, 'SANDBOX'), ['s1']);
  assert.deepEqual(await book(db, 'PRODUCTION'), ['s1'], 'PRODUCTION still gets S1');
  assert.equal(store.simulators.length, 1, 'no per-environment simulator rows');
});

test('2. a PRODUCTION allocation does not block SANDBOX', async () => {
  const store = createFakeDbStore(ONE_STATIC);
  const db = createFakeDbClient(store);
  assert.deepEqual(await book(db, 'PRODUCTION'), ['s1']);
  assert.deepEqual(await book(db, 'SANDBOX'), ['s1']);
});

test('3. two PRODUCTION bookings still conflict (and two SANDBOX ones)', async () => {
  const store = createFakeDbStore(ONE_STATIC);
  const db = createFakeDbClient(store);
  assert.deepEqual(await book(db, 'PRODUCTION'), ['s1']);
  assert.equal(await book(db, 'PRODUCTION'), null);
  assert.deepEqual(await book(db, 'SANDBOX'), ['s1']);
  assert.equal(await book(db, 'SANDBOX'), null);
});

test('isolation holds per requirement shape: a SANDBOX Grand Race leaves every rig free for a PRODUCTION Duo', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);
  assert.deepEqual(await book(db, 'SANDBOX', { static: 2, motion: 2 }), ['s1', 's2', 'm1', 'm2']);
  assert.deepEqual(await book(db, 'PRODUCTION', { static: 2, motion: 0 }), ['s1', 's2']);
  assert.equal(await book(db, 'PRODUCTION', { static: 1, motion: 0 }), null, 'but PRODUCTION demand still adds up');
});

test('legacy (allocation-less) bookings only count against their own environment', async () => {
  const store = createFakeDbStore(ONE_STATIC);
  store.legacyBookings.push({
    id: 'legacy-prod',
    booking_environment: 'PRODUCTION',
    simulator_type: 'static',
    racers: 1,
    status: 'pending',
    scheduled_start_at: START,
    scheduled_end_at: END,
  });
  const db = createFakeDbClient(store);
  assert.equal(await book(db, 'PRODUCTION'), null, 'the PRODUCTION legacy booking holds the one static rig');
  assert.deepEqual(await book(db, 'SANDBOX'), ['s1'], 'invisible to SANDBOX');
});

test('6. the one simulators lock is still taken and still serializes concurrent allocators (both environments)', async () => {
  // Two concurrent PRODUCTION requests for the last rig: exactly one wins, at every interleaving.
  for (let round = 0; round < 5; round += 1) {
    const store = createFakeDbStore(ONE_STATIC);
    const results = await Promise.all([book(createFakeDbClient(store), 'PRODUCTION'), book(createFakeDbClient(store), 'PRODUCTION')]);
    assert.equal(results.filter((r) => r !== null).length, 1, `round ${round}`);
    assert.equal(store.allocations.length, 1);
  }
  // A SANDBOX and a PRODUCTION request both succeed, but still one at a time under the same lock.
  const store = createFakeDbStore(ONE_STATIC);
  const order: string[] = [];
  const traced = (env: 'SANDBOX' | 'PRODUCTION'): DbClient => {
    const inner = createFakeDbClient(store);
    return {
      async query<T extends object>(text: string, params?: unknown[]) {
        if (/FOR UPDATE/.test(text)) order.push(`${env}:lock-wait`);
        const res = await inner.query<T>(text, params);
        if (/FOR UPDATE/.test(text)) order.push(`${env}:locked`);
        if (/^(COMMIT|ROLLBACK)/.test(text)) order.push(`${env}:release`);
        return res;
      },
    };
  };
  const [a, b] = await Promise.all([
    book(traced('SANDBOX') as ReturnType<typeof createFakeDbClient>, 'SANDBOX'),
    book(traced('PRODUCTION') as ReturnType<typeof createFakeDbClient>, 'PRODUCTION'),
  ]);
  assert.deepEqual([a, b], [['s1'], ['s1']]);
  const firstRelease = order.findIndex((e) => e.endsWith(':release'));
  const secondLocked = order.findIndex((e, i) => e.endsWith(':locked') && i > order.findIndex((x) => x.endsWith(':locked')));
  assert.ok(secondLocked > firstRelease, `second transaction only locks after the first releases: ${order.join(', ')}`);
});

// ---- capacity recovery (late payment / admin confirm) uses the booking's own environment -------

async function recover(store: ReturnType<typeof createFakePaymentDbStore>, bookingId: string) {
  const db = createFakePaymentDbClient(store);
  await db.query('BEGIN');
  const booking = await lockBookingForPayment(db, bookingId);
  assert.ok(booking);
  const outcome = await secureBookingCapacity(db, booking);
  await db.query('COMMIT');
  return outcome;
}

test('capacity recovery: an expired PRODUCTION hold re-allocates past SANDBOX occupancy of the same rig', async () => {
  const store = createFakePaymentDbStore();
  const expired = new Date(Date.now() - 60_000);
  const start = new Date(Date.now() + 24 * 3600_000);
  const prod = seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'PRODUCTION', holdExpiresAt: expired, simulatorIds: ['sim-S1'], start });
  // SANDBOX test bookings now confirmed on BOTH static rigs for the same window.
  seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'SANDBOX', allocationStatus: 'confirmed', simulatorIds: ['sim-S1', 'sim-S2'], holdAllocations: 2, start });
  const outcome = await recover(store, prod.id);
  assert.equal(outcome.kind, 'reallocated');
  assert.ok(outcome.kind === 'reallocated' && outcome.sameSimulators, 'back on S1 — SANDBOX never counted');
});

test('capacity recovery: PRODUCTION occupancy DOES block an expired PRODUCTION hold', async () => {
  const store = createFakePaymentDbStore();
  const start = new Date(Date.now() + 24 * 3600_000);
  const prod = seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'PRODUCTION', holdExpiresAt: new Date(Date.now() - 60_000), simulatorIds: ['sim-S1'], start });
  seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'PRODUCTION', allocationStatus: 'confirmed', simulatorIds: ['sim-S1', 'sim-S2'], holdAllocations: 2, start });
  const outcome = await recover(store, prod.id);
  assert.equal(outcome.kind, 'unavailable');
  assert.deepEqual(findDoubleBookings(store), []);
});

test('capacity recovery: an expired SANDBOX hold is not blocked by PRODUCTION occupancy', async () => {
  const store = createFakePaymentDbStore();
  const start = new Date(Date.now() + 24 * 3600_000);
  const sandbox = seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'SANDBOX', holdExpiresAt: new Date(Date.now() - 60_000), simulatorIds: ['sim-S1'], start });
  seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'PRODUCTION', allocationStatus: 'confirmed', simulatorIds: ['sim-S1', 'sim-S2'], holdAllocations: 2, start });
  assert.equal((await recover(store, sandbox.id)).kind, 'reallocated');
});

test('capacity recovery fails closed on a booking with no stored environment (never guesses one)', async () => {
  const store = createFakePaymentDbStore();
  const b = seedBooking(store, { priceInr: '599.00', bookingEnvironment: null, holdExpiresAt: new Date(Date.now() - 60_000) });
  await assert.rejects(recover(store, b.id), /booking_environment must be SANDBOX or PRODUCTION/);
});

// ---- public availability ------------------------------------------------------------------------

async function slots(store: ReturnType<typeof createFakePaymentDbStore>, env: 'SANDBOX' | 'PRODUCTION', date: string) {
  const handler = createAvailabilityHandler(env, { getDb: async () => createFakePaymentDbClient(store), resetDb: () => {} });
  const res = await handler({ queryStringParameters: { productCode: 'solo-pro-static', date } });
  assert.equal(res.statusCode, 200);
  return (JSON.parse(String(res.body)) as { availableSlots: string[] }).availableSlots;
}

test('availability: /availability/production sees only PRODUCTION occupancy; /availability only SANDBOX', async () => {
  // A far-future Tuesday so the "past date" rule never interferes.
  const date = '2027-10-05';
  const start = new Date('2027-10-05T12:30:00Z'); // 18:00 IST
  const store = createFakePaymentDbStore();
  seedBooking(store, { priceInr: '599.00', bookingEnvironment: 'PRODUCTION', allocationStatus: 'confirmed', simulatorIds: ['sim-S1', 'sim-S2'], holdAllocations: 2, start });
  const prod = await slots(store, 'PRODUCTION', date);
  const sandbox = await slots(store, 'SANDBOX', date);
  assert.ok(!prod.includes('18:00') && !prod.includes('17:45') && !prod.includes('18:15'), 'both static rigs busy in PRODUCTION');
  assert.ok(prod.includes('18:30') && prod.includes('17:30'));
  assert.ok(sandbox.includes('18:00') && sandbox.includes('18:15'), 'PRODUCTION occupancy is invisible to SANDBOX');

  // And the reverse.
  const store2 = createFakePaymentDbStore();
  seedBooking(store2, { priceInr: '599.00', bookingEnvironment: 'SANDBOX', allocationStatus: 'confirmed', simulatorIds: ['sim-S1', 'sim-S2'], holdAllocations: 2, start });
  assert.ok(!(await slots(store2, 'SANDBOX', date)).includes('18:00'));
  assert.ok((await slots(store2, 'PRODUCTION', date)).includes('18:00'));
});

test('availability handler factory: unknown environments fail at construction', () => {
  for (const env of [undefined, '', 'production', 'LIVE']) {
    assert.throws(() => createAvailabilityHandler(env as never), /availabilityEnvironment must be SANDBOX or PRODUCTION/);
  }
});

// ---- admin simulator board ----------------------------------------------------------------------

test('admin simulator board is PRODUCTION operational occupancy only', async () => {
  assert.equal(SIMULATOR_BOARD_ENVIRONMENT, 'PRODUCTION');
  const calls: { text: string; params: unknown[] }[] = [];
  const db: DbClient = {
    async query<T extends object>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      if (/FROM simulators/.test(text)) {
        return { rows: SIMULATORS as unknown as T[] };
      }
      return { rows: [] as T[] };
    },
  };
  await getSimulatorBoard(db, '2026-10-06');
  const board = calls.find((c) => /FROM booking_allocations ba/.test(c.text));
  assert.ok(board);
  assert.match(board.text, /AND b\.booking_environment = \$3/);
  assert.equal(board.params[2], 'PRODUCTION');
});

test('the real occupancy SQL scopes through the owning booking\'s environment (fakes only emulate it)', async () => {
  const calls: { text: string; params: unknown[] }[] = [];
  const db: DbClient = {
    async query<T extends object>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return { rows: [] as T[] };
    },
  };
  await loadBlockingAllocations(db, START, END, 'PRODUCTION');
  await loadLegacyBookingWindows(db, START, END, 'SANDBOX', null);
  const [blocking, legacy] = calls;
  assert.match(blocking.text, /FROM booking_allocations ba\s+JOIN bookings b ON b\.id = ba\.booking_id/);
  assert.match(blocking.text, /AND b\.booking_environment = \$3/);
  assert.deepEqual(blocking.params, [START, END, 'PRODUCTION']);
  assert.match(legacy.text, /AND b\.booking_environment = \$4/);
  assert.match(legacy.text, /b\.id IS DISTINCT FROM \$3::uuid/);
  assert.deepEqual(legacy.params, [START, END, null, 'SANDBOX']);
  // Unknown environments never reach SQL.
  await assert.rejects(loadBlockingAllocations(db, START, END, 'LIVE' as never), /environment must be SANDBOX or PRODUCTION/);
  await assert.rejects(loadLegacyBookingWindows(db, START, END, null as never, null), /environment must be SANDBOX or PRODUCTION/);
  assert.equal(calls.length, 2);
});
