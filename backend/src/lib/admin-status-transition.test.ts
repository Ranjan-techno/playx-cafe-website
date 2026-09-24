import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DbClient } from './allocate-simulators';
import { transitionBookingStatus } from './admin-repository';
import {
  createFakePaymentDbClient as createFakeAdminDbClient,
  createFakePaymentDbStore as createFakeAdminDbStore,
  seedBooking,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';

// Thin adapters over the shared fake DB (test-support/fake-payment-db.ts) — one fake now backs
// payments, allocation and admin transitions so they all share the same simulator lock.
function seedAdminBooking(store: FakePaymentDbStore, input: { status: string }) {
  return seedBooking(store, { status: input.status, priceInr: '100.00', holdAllocations: 0 });
}
let adminSimIndex = 0;
function seedAdminAllocation(
  store: FakePaymentDbStore,
  input: { bookingId: string; status: 'hold' | 'confirmed' | 'released'; holdExpiresAt?: Date | null },
) {
  const booking = store.bookings.find((b) => b.id === input.bookingId)!;
  const simulator = store.simulators.filter((s) => s.simulator_type === 'static')[adminSimIndex++ % 2];
  const allocation = {
    id: `admin-alloc-${store.allocations.length + 1}-${adminSimIndex}`,
    booking_id: booking.id,
    simulator_id: simulator.id,
    scheduled_start_at: booking.scheduled_start_at,
    scheduled_end_at: booking.scheduled_end_at,
    allocation_status: input.status,
    hold_expires_at: input.status === 'hold' ? (input.holdExpiresAt ?? new Date(Date.now() + 15 * 60_000)) : null,
  };
  store.allocations.push(allocation);
  return allocation;
}

// Phase 3B: PATCH /admin/bookings/{id}/status — the one admin-repository.ts function that owns a
// real transaction (lock -> validate -> update bookings -> conditionally release allocations ->
// commit), so it's the one exercised against a fake DB rather than tested only as pure shaping —
// same rationale as confirm-successful-payment.test.ts testing the real function against
// fake-payment-db.ts instead of reimplementing its transaction logic in the test.

// Issue 1 (this phase's audit brief): an admin manually confirming a pending (walk-in/cash)
// booking must never leave it 'confirmed' while its allocation is still a temporary, expirable
// HOLD. transitionBookingStatus() must atomically flip the allocation to 'confirmed' and clear
// hold_expires_at in the same transaction — reusing payment-repository.ts's
// confirmBookingAllocations(), the same writer a successful payment already uses.
test('pending -> confirmed: booking becomes confirmed AND its HOLD allocation becomes confirmed with hold_expires_at cleared, atomically', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocation = seedAdminAllocation(store, {
    bookingId: booking.id,
    status: 'hold',
    holdExpiresAt: new Date(Date.now() + 15 * 60_000),
  });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'confirmed');

  assert.deepEqual(result, { outcome: 'ok', id: booking.id, status: 'confirmed' });
  assert.equal(store.bookings.find((b) => b.id === booking.id)?.status, 'confirmed');
  const confirmedAllocation = store.allocations.find((a) => a.id === allocation.id);
  assert.equal(confirmedAllocation?.allocation_status, 'confirmed');
  // Never leave booking=confirmed with allocation still a HOLD (which is what hold_expires_at !=
  // null on a non-'hold' row would otherwise imply) — this is exactly the state item 5 forbids.
  assert.equal(confirmedAllocation?.hold_expires_at, null);
});

test('pending -> confirmed with multiple allocations (Duo/Grand Race): every HOLD allocation is confirmed, not just one', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocationA = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const allocationB = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const db = createFakeAdminDbClient(store);

  await transitionBookingStatus(db, booking.id, 'confirmed');

  for (const allocation of [allocationA, allocationB]) {
    const row = store.allocations.find((a) => a.id === allocation.id);
    assert.equal(row?.allocation_status, 'confirmed');
    assert.equal(row?.hold_expires_at, null);
  }
});

test('pending -> confirmed never leaves the forbidden state: booking=confirmed with any allocation still =hold', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const db = createFakeAdminDbClient(store);

  await transitionBookingStatus(db, booking.id, 'confirmed');

  const bookingRow = store.bookings.find((b) => b.id === booking.id);
  const stillOnHold = store.allocations.filter((a) => a.booking_id === booking.id && a.allocation_status === 'hold');
  assert.ok(!(bookingRow?.status === 'confirmed' && stillOnHold.length > 0), 'booking=confirmed with a HOLD allocation must never happen');
  assert.equal(stillOnHold.length, 0);
});

test('database transaction rolls back on failure: a mid-transaction error during pending -> confirmed undoes both the booking and allocation writes', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocation = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const realDb = createFakeAdminDbClient(store);

  // Simulates a hard DB error on the allocation-confirming write, which runs *after* the booking
  // status write has already been issued in the same transaction — proving COMMIT never partially
  // applies and ROLLBACK undoes the earlier write too.
  const flakyDb: DbClient = {
    query: async (text, params) => {
      const sql = text.trim();
      if (/^UPDATE booking_allocations\b/i.test(sql) && /SET allocation_status = 'confirmed'/i.test(sql)) {
        throw new Error('simulated connection loss');
      }
      return realDb.query(text, params);
    },
  };

  await assert.rejects(() => transitionBookingStatus(flakyDb, booking.id, 'confirmed'));

  assert.equal(store.bookings.find((b) => b.id === booking.id)?.status, 'pending', 'booking status write must have been rolled back');
  assert.equal(store.allocations.find((a) => a.id === allocation.id)?.allocation_status, 'hold', 'allocation must remain untouched');
});

test('critical example: cancelling a pending booking releases its HOLD allocation so it stops blocking availability', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocation = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'cancelled');

  assert.deepEqual(result, { outcome: 'ok', id: booking.id, status: 'cancelled' });
  assert.equal(store.bookings.find((b) => b.id === booking.id)?.status, 'cancelled');
  const releasedAllocation = store.allocations.find((a) => a.id === allocation.id);
  assert.equal(releasedAllocation?.allocation_status, 'released');
  assert.equal(releasedAllocation?.hold_expires_at, null);
});

test('cancelling a confirmed booking also releases its confirmed (no-expiry) allocation', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'confirmed' });
  const allocation = seedAdminAllocation(store, { bookingId: booking.id, status: 'confirmed' });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'cancelled');

  assert.equal(result.outcome, 'ok');
  assert.equal(store.allocations.find((a) => a.id === allocation.id)?.allocation_status, 'released');
});

test('cancelling a booking with multiple allocations (e.g. a Duo/Grand Race booking) releases all of them', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocationA = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const allocationB = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const db = createFakeAdminDbClient(store);

  await transitionBookingStatus(db, booking.id, 'cancelled');

  assert.equal(store.allocations.find((a) => a.id === allocationA.id)?.allocation_status, 'released');
  assert.equal(store.allocations.find((a) => a.id === allocationB.id)?.allocation_status, 'released');
});

test('valid transition: confirmed -> completed does not release the allocation (the session already happened)', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'confirmed' });
  const allocation = seedAdminAllocation(store, { bookingId: booking.id, status: 'confirmed' });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'completed');

  assert.equal(result.outcome, 'ok');
  assert.equal(store.allocations.find((a) => a.id === allocation.id)?.allocation_status, 'confirmed');
});

test('invalid transition: pending -> completed is rejected, no write happens', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'pending' });
  const allocation = seedAdminAllocation(store, { bookingId: booking.id, status: 'hold' });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'completed');

  assert.deepEqual(result, { outcome: 'invalid_transition', from: 'pending', to: 'completed' });
  assert.equal(store.bookings.find((b) => b.id === booking.id)?.status, 'pending');
  assert.equal(store.allocations.find((a) => a.id === allocation.id)?.allocation_status, 'hold');
});

test('invalid transition: a terminal status (cancelled) accepts no further transition', async () => {
  const store = createFakeAdminDbStore();
  const booking = seedAdminBooking(store, { status: 'cancelled' });
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, booking.id, 'confirmed');

  assert.deepEqual(result, { outcome: 'invalid_transition', from: 'cancelled', to: 'confirmed' });
});

test('unknown booking id: returns not_found rather than throwing or fabricating a row', async () => {
  const store = createFakeAdminDbStore();
  const db = createFakeAdminDbClient(store);

  const result = await transitionBookingStatus(db, 'does-not-exist', 'cancelled');

  assert.deepEqual(result, { outcome: 'not_found' });
});

// ---------------------------------------------------------------------------------------------
// Capacity safety: admin pending -> confirmed must go through the same capacity primitive as a
// successful payment — it may never flip an EXPIRED hold to confirmed over someone else's booking.
// ---------------------------------------------------------------------------------------------
import { afterEach, mock } from 'node:test';
import { findDoubleBookings } from './test-support/fake-payment-db';

afterEach(() => mock.timers.reset());

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const SLOT_START = new Date(T0 + 24 * 60 * MIN);
const SLOT_END = new Date(SLOT_START.getTime() + 30 * MIN);

function pendingWithHold(store: FakePaymentDbStore, simulatorId = 'sim-S1') {
  return seedBooking(store, {
    priceInr: '100.00', simulatorIds: [simulatorId], holdExpiresAt: new Date(T0 + 15 * MIN), start: SLOT_START, end: SLOT_END,
  });
}
const takenBy = (store: FakePaymentDbStore, simulatorId: string) =>
  seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: [simulatorId], start: SLOT_START, end: SLOT_END });

test('admin confirm with a still-valid hold works as before', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 5 * MIN });
  const store = createFakeAdminDbStore();
  const booking = pendingWithHold(store);
  const result = await transitionBookingStatus(createFakeAdminDbClient(store), booking.id, 'confirmed');
  assert.deepEqual(result, { outcome: 'ok', id: booking.id, status: 'confirmed' });
  assert.deepEqual(store.allocations.map((a) => a.allocation_status), ['confirmed']);
});

test('admin confirm with an EXPIRED hold whose rig was given to someone else is REFUSED and rolled back — the unsafe blind flip is gone', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 16 * MIN });
  const store = createFakeAdminDbStore();
  const booking = pendingWithHold(store);
  takenBy(store, 'sim-S1');
  takenBy(store, 'sim-S2');
  const before = JSON.stringify([store.allocations, store.bookings]);

  const result = await transitionBookingStatus(createFakeAdminDbClient(store), booking.id, 'confirmed');

  assert.deepEqual(result, { outcome: 'capacity_unavailable' });
  assert.equal(JSON.stringify([store.allocations, store.bookings]), before, 'nothing changed: still pending, hold untouched');
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), []);
});

test('admin confirm with an EXPIRED hold, original rig taken, alternate rig free: re-allocated (reported) and confirmed — never double-booked', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 16 * MIN });
  const store = createFakeAdminDbStore();
  const booking = pendingWithHold(store);
  takenBy(store, 'sim-S1');

  const result = await transitionBookingStatus(createFakeAdminDbClient(store), booking.id, 'confirmed');

  assert.deepEqual(result, { outcome: 'ok', id: booking.id, status: 'confirmed', reallocated: true });
  const live = store.allocations.filter((a) => a.booking_id === booking.id && a.allocation_status !== 'released');
  assert.deepEqual(live.map((a) => [a.simulator_id, a.allocation_status]), [['sim-S2', 'confirmed']]);
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), []);
});

test('admin confirm with an EXPIRED hold and the same rig still free: re-confirmed on that rig', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 16 * MIN });
  const store = createFakeAdminDbStore();
  const booking = pendingWithHold(store);
  const result = await transitionBookingStatus(createFakeAdminDbClient(store), booking.id, 'confirmed');
  assert.equal(result.outcome, 'ok');
  assert.deepEqual(store.allocations.filter((a) => a.allocation_status === 'confirmed').map((a) => a.simulator_id), ['sim-S1']);
});

test('admin confirm takes the shared lock order: booking -> simulators -> allocations', async () => {
  mock.timers.enable({ apis: ['Date'], now: T0 + 5 * MIN });
  const store = createFakeAdminDbStore();
  const booking = pendingWithHold(store);
  const db = createFakeAdminDbClient(store);
  await transitionBookingStatus(db, booking.id, 'confirmed');
  assert.deepEqual(db.lockLog, ['booking', 'simulators', 'allocations']);
});
