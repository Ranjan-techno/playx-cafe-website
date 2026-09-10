import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateSimulators } from './allocate-simulators';
import { createFakeDbClient, createFakeDbStore } from './test-support/fake-db';
import type { SimulatorRow } from './simulator-allocation';

// Exercises the *real* allocateSimulators() (not a reimplementation) against the fake in-memory
// DB in test-support/fake-db.ts — see that file's header for why a fake rather than a real
// Postgres connection. Every test opens a transaction the same way create-booking.ts does (BEGIN,
// insert a booking row, call allocateSimulators, then COMMIT or ROLLBACK) so the locking strategy
// under test is exactly the one the handler actually runs.

const SIMULATORS: SimulatorRow[] = [
  { id: 's1', code: 'S1', simulator_type: 'static' },
  { id: 's2', code: 'S2', simulator_type: 'static' },
  { id: 'm1', code: 'M1', simulator_type: 'motion' },
  { id: 'm2', code: 'M2', simulator_type: 'motion' },
];

const SLOT_START = new Date('2026-09-10T05:30:00Z'); // 11:00 IST
const SLOT_END = new Date('2026-09-10T06:00:00Z'); // 11:30 IST

async function makeBooking(db: ReturnType<typeof createFakeDbClient>): Promise<string> {
  const { rows } = await db.query<{ id: string }>('INSERT INTO bookings (id) VALUES (default) RETURNING id');
  return rows[0].id;
}

test('static allocation: Solo Static succeeds and allocates a static rig', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds, ['s1']);
});

test('motion allocation: Solo Motion succeeds and allocates a motion rig', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 0, motion: 1 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds, ['m1']);
});

test('duo allocation: Duo Motion succeeds and allocates both motion rigs', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 0, motion: 2 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds.sort(), ['m1', 'm2']);
});

test('duo allocation: Duo Static succeeds and allocates both static rigs', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds.sort(), ['s1', 's2']);
});

test('Grand Race: succeeds only when all 4 rigs are free, and allocates all 4', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 2 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds.sort(), ['m1', 'm2', 's1', 's2']);
});

test('conflicting booking: a second Solo Static request for the same window is rejected once both static rigs are taken', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  // Two Solo Static bookings take S1 and S2 in turn (sequential — the concurrency test below
  // covers the racing case).
  for (let i = 0; i < 2; i += 1) {
    await db.query('BEGIN');
    const bookingId = await makeBooking(db);
    const result = await allocateSimulators(db, {
      bookingId,
      requirement: { static: 1, motion: 0 },
      scheduledStartAt: SLOT_START,
      scheduledEndAt: SLOT_END,
      holdMinutes: 15,
    });
    assert.ok(result, `booking ${i} should have succeeded`);
    await db.query('COMMIT');
  }

  // A third, overlapping Solo Static request: no static rig is free — reject, don't allocate.
  await db.query('BEGIN');
  const thirdBookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId: thirdBookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  assert.equal(result, null);
  await db.query('ROLLBACK');

  assert.equal(store.allocations.length, 2, 'the rejected attempt must not have inserted an allocation row');
});

test('conflicting booking: Duo Static is rejected while a Solo Static booking holds one of the two required static rigs', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const soloBookingId = await makeBooking(db);
  await allocateSimulators(db, {
    bookingId: soloBookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  await db.query('BEGIN');
  const duoBookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId: duoBookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  assert.equal(result, null, 'Duo Static needs both static rigs — one being taken must reject the whole booking');
  await db.query('ROLLBACK');
});

test('adjacent booking: a booking ending exactly when another starts does not block it (half-open interval)', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  const firstStart = new Date('2026-09-10T08:30:00Z'); // 14:00 IST
  const firstEnd = new Date('2026-09-10T09:00:00Z'); // 14:30 IST
  const secondStart = firstEnd; // 14:30 IST
  const secondEnd = new Date('2026-09-10T09:30:00Z'); // 15:00 IST

  await db.query('BEGIN');
  const firstBookingId = await makeBooking(db);
  const firstResult = await allocateSimulators(db, {
    bookingId: firstBookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: firstStart,
    scheduledEndAt: firstEnd,
    holdMinutes: 15,
  });
  await db.query('COMMIT');
  assert.ok(firstResult, '14:00-14:30 booking taking both static rigs should succeed');

  await db.query('BEGIN');
  const secondBookingId = await makeBooking(db);
  const secondResult = await allocateSimulators(db, {
    bookingId: secondBookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: secondStart,
    scheduledEndAt: secondEnd,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(secondResult, 'the back-to-back 14:30-15:00 booking must be allowed, not treated as overlapping');
  assert.deepEqual(secondResult.simulatorIds.sort(), ['s1', 's2']);
});

test('released allocation: a released allocation does not block a new overlapping booking', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.allocations.push({
    id: 'released-alloc',
    booking_id: 'cancelled-booking',
    simulator_id: 's1',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
    allocation_status: 'released',
    hold_expires_at: null,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result, 'a released allocation must not block inventory');
  assert.deepEqual(result.simulatorIds, ['s1'], 'the released rig is free to be picked again');
});

test('confirmed allocation: a confirmed allocation (no expiry) blocks a new overlapping booking indefinitely', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.allocations.push({
    id: 'confirmed-alloc',
    booking_id: 'other-booking',
    simulator_id: 's1',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
    allocation_status: 'confirmed',
    hold_expires_at: null,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds, ['s2'], 'S1 is confirmed (not just held), so only S2 is free');
});

test('same hold_expires_at: a Duo Static booking\'s two allocation rows share the exact same hold_expires_at', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  const rows = store.allocations.filter((a) => a.booking_id === bookingId);
  assert.equal(rows.length, 2);
  // allocateSimulators() always writes a real hold_expires_at for a fresh 'hold' row (see the
  // booking_allocations_hold_expiry_chk constraint) — the `!` reflects that invariant, not an
  // untested assumption.
  assert.equal(rows[0].hold_expires_at!.getTime(), rows[1].hold_expires_at!.getTime());
  assert.equal(rows[0].hold_expires_at!.getTime(), result.holdExpiresAt.getTime());
});

test('same hold_expires_at: a Grand Race booking\'s four allocation rows all share the exact same hold_expires_at', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 2 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  const rows = store.allocations.filter((a) => a.booking_id === bookingId);
  assert.equal(rows.length, 4);
  const distinctTimestamps = new Set(rows.map((r) => r.hold_expires_at?.getTime()));
  assert.equal(distinctTimestamps.size, 1, 'all four rows must carry the exact same hold_expires_at instant');
});

// Legacy-booking backward compatibility — see allocate-simulators.ts's header and
// database/migrations/002_simulator_inventory.sql's "Existing (pre-Phase-2) bookings" note. These
// exercise the real allocateSimulators() against a seeded FakeLegacyBookingRow, not a
// reimplementation of the legacy query.

test('legacy booking: a pre-Phase-2 Solo Static booking with no allocation rows blocks a new overlapping Duo Static request', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  // Simulates a booking row that existed before this feature shipped: present in `bookings`,
  // absent from `booking_allocations`.
  store.legacyBookings.push({
    id: 'legacy-booking-1',
    simulator_type: 'static',
    racers: 1,
    status: 'pending', // the only status the app has ever written — see create-booking.ts.
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 0 }, // Duo Static needs both rigs.
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('ROLLBACK');

  assert.equal(result, null, 'the legacy booking already claims 1 of 2 static rigs, so Duo Static cannot fit');
});

test('legacy booking: a pre-Phase-2 booking still allows a new Solo Static request for the one remaining rig', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.legacyBookings.push({
    id: 'legacy-booking-2',
    simulator_type: 'static',
    racers: 1,
    status: 'pending',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result, 'only 1 of 2 static rigs is legacy-claimed, so a second Solo Static still fits');
  assert.deepEqual(result.simulatorIds, ['s1'], 'the new booking is free to be recorded against either rig');
});

test('legacy booking: a cancelled pre-Phase-2 booking does not block a new overlapping request', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.legacyBookings.push({
    id: 'legacy-booking-cancelled',
    simulator_type: 'static',
    racers: 2, // would otherwise consume both static rigs
    status: 'cancelled',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 2, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result, 'a cancelled legacy booking must not reserve any capacity');
});

test('legacy booking: a legacy Grand Race booking (simulator_type NULL, racers 4) reserves all 4 rigs', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.legacyBookings.push({
    id: 'legacy-grand-race',
    simulator_type: null,
    racers: 4,
    status: 'pending',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 }, // even a single Solo Static can't fit anywhere.
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('ROLLBACK');

  assert.equal(result, null, 'a legacy Grand Race must be treated as occupying all 4 rigs, not 0');
});

test('expired hold: an allocation whose hold_expires_at is in the past does not block a new overlapping booking', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  // Seed an expired HOLD directly on S1 — as if a prior booking's 15-minute window had lapsed
  // with nothing confirming it.
  store.allocations.push({
    id: 'expired-hold',
    booking_id: 'stale-booking',
    simulator_id: 's1',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
    allocation_status: 'hold',
    hold_expires_at: new Date(Date.now() - 60_000),
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result, 'an expired hold must not block a new booking for the same simulator/window');
  assert.deepEqual(result.simulatorIds, ['s1'], 'the freed-up rig (lowest code) should be the one picked');
});

test('expired hold: a still-active hold (not yet expired) keeps blocking, matching the confirmed case', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const db = createFakeDbClient(store);

  store.allocations.push({
    id: 'active-hold',
    booking_id: 'other-booking',
    simulator_id: 's1',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
    allocation_status: 'hold',
    hold_expires_at: new Date(Date.now() + 60_000),
  });

  await db.query('BEGIN');
  const bookingId = await makeBooking(db);
  const result = await allocateSimulators(db, {
    bookingId,
    requirement: { static: 1, motion: 0 },
    scheduledStartAt: SLOT_START,
    scheduledEndAt: SLOT_END,
    holdMinutes: 15,
  });
  await db.query('COMMIT');

  assert.ok(result);
  assert.deepEqual(result.simulatorIds, ['s2'], 'S1 is still held, so the other free static rig is picked');
});

test('concurrent request safety: two overlapping Solo Static requests racing for the last free rig — exactly one succeeds', async () => {
  const store = createFakeDbStore(SIMULATORS);
  // S1 is already booked, leaving exactly one free static rig (S2) for two customers to race for.
  store.allocations.push({
    id: 'pre-existing',
    booking_id: 'existing-booking',
    simulator_id: 's1',
    scheduled_start_at: SLOT_START,
    scheduled_end_at: SLOT_END,
    allocation_status: 'confirmed',
    hold_expires_at: null,
  });

  const dbA = createFakeDbClient(store);
  const dbB = createFakeDbClient(store);

  const attempt = async (db: ReturnType<typeof createFakeDbClient>) => {
    await db.query('BEGIN');
    const bookingId = await makeBooking(db);
    const result = await allocateSimulators(db, {
      bookingId,
      requirement: { static: 1, motion: 0 },
      scheduledStartAt: SLOT_START,
      scheduledEndAt: SLOT_END,
      holdMinutes: 15,
    });
    if (result) {
      await db.query('COMMIT');
    } else {
      await db.query('ROLLBACK');
    }
    return result;
  };

  // Genuinely concurrent: both start before either finishes its first await.
  const [resultA, resultB] = await Promise.all([attempt(dbA), attempt(dbB)]);

  const succeeded = [resultA, resultB].filter((r) => r !== null);
  assert.equal(succeeded.length, 1, 'exactly one of the two racing requests must succeed');
  assert.deepEqual(succeeded[0]?.simulatorIds, ['s2'], 'the only free rig, S2, is the one that gets allocated');

  // The losing attempt must not have left a stray allocation behind.
  const s2Allocations = store.allocations.filter((a) => a.simulator_id === 's2');
  assert.equal(s2Allocations.length, 1);
});

test('concurrent request safety: two Solo Static requests for two different free rigs both succeed without colliding', async () => {
  const store = createFakeDbStore(SIMULATORS);
  const dbA = createFakeDbClient(store);
  const dbB = createFakeDbClient(store);

  const attempt = async (db: ReturnType<typeof createFakeDbClient>) => {
    await db.query('BEGIN');
    const bookingId = await makeBooking(db);
    const result = await allocateSimulators(db, {
      bookingId,
      requirement: { static: 1, motion: 0 },
      scheduledStartAt: SLOT_START,
      scheduledEndAt: SLOT_END,
      holdMinutes: 15,
    });
    if (result) {
      await db.query('COMMIT');
    } else {
      await db.query('ROLLBACK');
    }
    return result;
  };

  const [resultA, resultB] = await Promise.all([attempt(dbA), attempt(dbB)]);

  assert.ok(resultA);
  assert.ok(resultB);
  const allocated = [resultA.simulatorIds[0], resultB.simulatorIds[0]].sort();
  assert.deepEqual(allocated, ['s1', 's2'], 'each customer gets a distinct rig — no double-allocation');
});
