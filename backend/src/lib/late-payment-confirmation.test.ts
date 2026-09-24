import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { allocateSimulators } from './allocate-simulators';
import { confirmSuccessfulPayment } from './confirm-successful-payment';
import { AmountMismatchError } from './payment-errors';
import { createPaymentAttempt } from './payment-repository';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  findDoubleBookings,
  seedBooking,
  type FakeBookingRow,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';

// The late-payment contract (see confirm-successful-payment.ts header):
//   valid hold                      -> confirm
//   expired hold, capacity free      -> re-allocate under the simulators lock, confirm
//   expired hold, capacity gone      -> payment PAID + refundRequired, booking NOT confirmed, no double-booking

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const SLOT_START = new Date(T0 + 24 * 60 * MIN);
const SLOT_END = new Date(SLOT_START.getTime() + 30 * MIN);

afterEach(() => mock.timers.reset());
function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

/** A pending booking (1 static rig, on `simulatorId`) whose hold expires `holdMinutes` after T0, plus a created payment attempt. */
async function pendingWithPayment(store: FakePaymentDbStore, opts: { simulatorId?: string; holdMinutes?: number; price?: string } = {}) {
  const booking = seedBooking(store, {
    priceInr: opts.price ?? '999.00',
    simulatorIds: [opts.simulatorId ?? 'sim-S1'],
    holdExpiresAt: new Date(T0 + (opts.holdMinutes ?? 15) * MIN),
    start: SLOT_START,
    end: SLOT_END,
  });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: `order-${booking.id}`,
    amountInr: booking.price_inr,
    metadata: { environment: 'SANDBOX' },
  });
  return { booking, payment, db };
}

/** Another customer's confirmed booking on `simulatorId` for the same slot. */
const takenBy = (store: FakePaymentDbStore, simulatorId: string): FakeBookingRow =>
  seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: [simulatorId], start: SLOT_START, end: SLOT_END });

const pay = (db: ReturnType<typeof createFakePaymentDbClient>, orderId: string, amount: number | string = '999.00') =>
  confirmSuccessfulPayment(db, { provider: 'phonepe', providerOrderId: orderId, amountInr: amount, providerTransactionId: `tx-${orderId}` });

const rows = (store: FakePaymentDbStore, bookingId: string) => store.allocations.filter((a) => a.booking_id === bookingId);
const live = (store: FakePaymentDbStore, bookingId: string) => rows(store, bookingId).filter((a) => a.allocation_status !== 'released');

// ---- A. valid hold --------------------------------------------------------------------------

test('valid hold: confirmed normally on the SAME simulator, nothing reallocated', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 10 * MIN);

  const result = await pay(db, payment.provider_order_id);

  assert.equal(result.outcome, 'confirmed');
  assert.equal(store.bookings[0].status, 'confirmed');
  assert.deepEqual(rows(store, booking.id).map((a) => [a.simulator_id, a.allocation_status, a.hold_expires_at]), [['sim-S1', 'confirmed', null]]);
  assert.equal(store.payments[0].metadata?.lateConfirmation, undefined);
  assert.equal(store.payments[0].metadata?.refundRequired, undefined);
});

test('lock order for a confirmation is payment -> booking -> simulators -> allocations', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { payment, db } = await pendingWithPayment(store);
  await pay(db, payment.provider_order_id);
  assert.deepEqual(db.lockLog, ['payment', 'booking', 'simulators', 'allocations']);
});

// ---- B. expired hold, capacity still free ---------------------------------------------------

test('expired hold + original simulator still free: re-allocated to the SAME simulator and confirmed', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 16 * MIN);

  const result = await pay(db, payment.provider_order_id);

  assert.equal(result.outcome, 'confirmed_after_reallocation');
  assert.equal(store.bookings[0].status, 'confirmed');
  const byStatus = (s: string) => rows(store, booking.id).filter((a) => a.allocation_status === s);
  assert.deepEqual(byStatus('confirmed').map((a) => a.simulator_id), ['sim-S1']);
  assert.equal(byStatus('confirmed')[0].hold_expires_at, null);
  assert.equal(byStatus('hold').length, 0, 'the obsolete hold row is gone from the blocking set');
  assert.equal(byStatus('released').length, 1);
  assert.equal(store.payments[0].payment_status, 'paid');
  assert.deepEqual(store.payments[0].metadata?.lateConfirmation, {
    reallocated: true,
    sameSimulators: true,
    previousSimulatorIds: ['sim-S1'],
    simulatorIds: ['sim-S1'],
    detectedAt: new Date(T0 + 16 * MIN).toISOString(),
  });
  assert.deepEqual(findDoubleBookings(store), []);
});

test('expired hold + original simulator TAKEN + an alternate compatible simulator free: moved to the alternate and confirmed', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store, { simulatorId: 'sim-S1' });
  clockAt(T0 + 16 * MIN);
  const other = takenBy(store, 'sim-S1'); // someone else got S1 after the hold lapsed

  const result = await pay(db, payment.provider_order_id);

  assert.equal(result.outcome, 'confirmed_after_reallocation');
  assert.deepEqual(live(store, booking.id).map((a) => [a.simulator_id, a.allocation_status]), [['sim-S2', 'confirmed']], 'alternate STATIC rig, never a motion rig');
  assert.equal(store.payments[0].metadata?.lateConfirmation && (store.payments[0].metadata.lateConfirmation as { sameSimulators: boolean }).sameSimulators, false);
  assert.deepEqual(live(store, other.id).map((a) => a.simulator_id), ['sim-S1'], "the other customer's booking is untouched");
  assert.deepEqual(findDoubleBookings(store), []);
});

test('a Duo (2 static) booking needs BOTH rigs: with one taken it cannot be reallocated', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    priceInr: '1800.00', holdAllocations: 2, simulatorIds: ['sim-S1', 'sim-S2'], racers: 2, simulatorType: 'static',
    holdExpiresAt: new Date(T0 + 15 * MIN), start: SLOT_START, end: SLOT_END,
  });
  const db = createFakePaymentDbClient(store);
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'phonepe', providerOrderId: 'duo', amountInr: '1800.00' });
  clockAt(T0 + 16 * MIN);
  takenBy(store, 'sim-S2');

  const result = await pay(db, 'duo', '1800.00');

  assert.equal(result.outcome, 'refund_required');
  assert.deepEqual(findDoubleBookings(store), []);
});

// ---- C. expired hold, no capacity -----------------------------------------------------------

test('expired hold + no capacity: payment stays truthfully PAID, booking is NOT confirmed, refundRequired + reason recorded, no double-booking', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 16 * MIN);
  const b = takenBy(store, 'sim-S1');
  const c = takenBy(store, 'sim-S2');

  const result = await pay(db, payment.provider_order_id);

  assert.equal(result.outcome, 'refund_required');
  const stored = store.payments[0];
  assert.equal(stored.payment_status, 'paid', 'the money did move — the payment is recorded as it really is');
  assert.equal(stored.provider_transaction_id, `tx-${payment.provider_order_id}`);
  assert.ok(stored.paid_at instanceof Date);
  assert.equal(stored.metadata?.refundRequired, true);
  assert.equal(stored.metadata?.reason, 'hold_expired_capacity_unavailable');
  assert.equal(stored.metadata?.environment, 'SANDBOX', 'existing metadata is merged, not overwritten');
  assert.equal(store.bookings.find((x) => x.id === booking.id)!.status, 'cancelled', 'deterministic state for manual refund: never confirmed');
  assert.deepEqual(live(store, booking.id), [], 'obsolete holds are released so they cannot block capacity');
  assert.deepEqual(live(store, b.id).map((a) => a.simulator_id), ['sim-S1']);
  assert.deepEqual(live(store, c.id).map((a) => a.simulator_id), ['sim-S2']);
  assert.deepEqual(findDoubleBookings(store), []);
  assert.ok(!JSON.stringify(stored.metadata).match(/secret|password|token/i), 'metadata reason is structured and non-sensitive');
});

// ---- exact timeline -------------------------------------------------------------------------

async function bookViaAllocator(store: FakePaymentDbStore, price = '999.00'): Promise<{ booking: FakeBookingRow; ok: boolean }> {
  const booking = seedBooking(store, { priceInr: price, holdAllocations: 0, start: SLOT_START, end: SLOT_END });
  const db = createFakePaymentDbClient(store);
  await db.query('BEGIN');
  const allocation = await allocateSimulators(db, {
    bookingId: booking.id, requirement: { static: 1, motion: 0 }, scheduledStartAt: SLOT_START, scheduledEndAt: SLOT_END, holdMinutes: 15,
  });
  await db.query(allocation ? 'COMMIT' : 'ROLLBACK');
  return { booking, ok: allocation !== null };
}

test('T0 / T+15 / T+16 / T+17: A holds at T0; A\'s hold lapses at T+15; B and C book the freed rigs at T+16; A\'s payment succeeds at T+17 — NO double booking', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const a = await bookViaAllocator(store); // real allocateSimulators -> S1 on hold until T+15
  assert.deepEqual(rows(store, a.booking.id).map((r) => r.simulator_id), ['sim-S1']);
  const db = createFakePaymentDbClient(store);
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: a.booking.id, provider: 'phonepe', providerOrderId: 'order-A', amountInr: '999.00' });

  clockAt(T0 + 15 * MIN); // exactly at expiry the hold no longer blocks (hold_expires_at > now() is false)
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 15 * MIN)), []);

  clockAt(T0 + 16 * MIN);
  const b = await bookViaAllocator(store, '500.00');
  const c = await bookViaAllocator(store, '500.00');
  assert.ok(b.ok && c.ok, 'B and C legitimately get both static rigs (A no longer blocks)');
  assert.deepEqual(rows(store, b.booking.id).map((r) => r.simulator_id), ['sim-S1']);
  assert.deepEqual(rows(store, c.booking.id).map((r) => r.simulator_id), ['sim-S2']);

  clockAt(T0 + 17 * MIN);
  const result = await pay(db, 'order-A');

  assert.equal(result.outcome, 'refund_required');
  assert.equal(store.payments[0].payment_status, 'paid');
  assert.equal(store.payments[0].metadata?.refundRequired, true);
  assert.equal(store.bookings.find((x) => x.id === a.booking.id)!.status, 'cancelled');
  assert.deepEqual(live(store, a.booking.id), []);
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 17 * MIN)), []);
  assert.deepEqual(live(store, b.booking.id).map((r) => r.simulator_id), ['sim-S1']);
  assert.deepEqual(live(store, c.booking.id).map((r) => r.simulator_id), ['sim-S2']);
});

test('same timeline but only B booked in between: A is moved to the free rig S2 instead of being refused', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const a = await bookViaAllocator(store);
  const db = createFakePaymentDbClient(store);
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: a.booking.id, provider: 'phonepe', providerOrderId: 'order-A', amountInr: '999.00' });
  clockAt(T0 + 16 * MIN);
  await bookViaAllocator(store, '500.00'); // B takes S1

  clockAt(T0 + 17 * MIN);
  const result = await pay(db, 'order-A');

  assert.equal(result.outcome, 'confirmed_after_reallocation');
  assert.deepEqual(live(store, a.booking.id).map((r) => [r.simulator_id, r.allocation_status]), [['sim-S2', 'confirmed']]);
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 17 * MIN)), []);
});

test('boundary: paying at exactly T+15 (the hold expiry instant) counts as expired and goes through the capacity path', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 15 * MIN);
  const result = await pay(db, payment.provider_order_id);
  assert.equal(result.outcome, 'confirmed_after_reallocation');
  clockAt(T0 + 14 * MIN + 59_000);
  const store2 = createFakePaymentDbStore();
  clockAt(T0);
  const second = await pendingWithPayment(store2);
  clockAt(T0 + 14 * MIN + 59_000);
  assert.equal((await pay(second.db, second.payment.provider_order_id)).outcome, 'confirmed', 'one second earlier the hold is still valid');
});

// ---- idempotency ----------------------------------------------------------------------------

test('duplicate SUCCESS is idempotent for every outcome (confirmed / reallocated / refund-required): no extra rows, same outcome reported', async () => {
  for (const scenario of ['confirmed', 'confirmed_after_reallocation', 'refund_required'] as const) {
    clockAt(T0);
    const store = createFakePaymentDbStore();
    const { payment, db } = await pendingWithPayment(store);
    if (scenario !== 'confirmed') clockAt(T0 + 16 * MIN);
    if (scenario === 'refund_required') {
      takenBy(store, 'sim-S1');
      takenBy(store, 'sim-S2');
    }
    const first = await pay(db, payment.provider_order_id);
    const snapshot = JSON.stringify([store.allocations, store.bookings, store.payments]);
    const second = await pay(db, payment.provider_order_id);
    const third = await pay(db, payment.provider_order_id);

    assert.equal(first.outcome, scenario);
    assert.equal(first.alreadyConfirmed, false);
    assert.equal(second.alreadyConfirmed, true);
    assert.equal(second.outcome, scenario);
    assert.equal(third.outcome, scenario);
    assert.equal(JSON.stringify([store.allocations, store.bookings, store.payments]), snapshot, `${scenario}: replays change nothing`);
    assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  }
});

// ---- amount / integrity ---------------------------------------------------------------------

test('amount mismatch is rejected atomically — even for an expired hold nothing is released, reallocated or marked paid', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 16 * MIN);
  const before = JSON.stringify([store.allocations, store.bookings, store.payments]);

  await assert.rejects(() => pay(db, payment.provider_order_id, '998.99'), AmountMismatchError);
  await assert.rejects(() => pay(db, payment.provider_order_id, '1000.00'), AmountMismatchError);
  await assert.rejects(() => pay(db, payment.provider_order_id, 'not-a-number'), AmountMismatchError);
  await assert.rejects(() => pay(db, payment.provider_order_id, 0.1 + 0.2), AmountMismatchError);

  assert.equal(JSON.stringify([store.allocations, store.bookings, store.payments]), before);
  assert.equal(store.payments[0].payment_status, 'created');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
  assert.equal(db.inTransaction(), false);
});

test('amounts are compared exactly in paise: "999", 999, "999.0" and "999.00" all match a 999.00 payment', async () => {
  for (const amount of ['999', 999, '999.0', '999.00']) {
    clockAt(T0);
    const store = createFakePaymentDbStore();
    const { payment, db } = await pendingWithPayment(store);
    assert.equal((await pay(db, payment.provider_order_id, amount)).outcome, 'confirmed', String(amount));
  }
});

test('a rollback mid-way through a reallocation leaves the old hold, booking and payment exactly as they were', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { payment, db } = await pendingWithPayment(store);
  clockAt(T0 + 16 * MIN);
  const before = JSON.stringify([store.allocations, store.bookings, store.payments]);
  const flaky = {
    ...db,
    query: async (text: string, params?: unknown[]) => {
      if (/^UPDATE bookings\b/i.test(text.trim())) throw new Error('simulated connection loss');
      return db.query(text, params);
    },
  } as typeof db;
  await assert.rejects(() => pay(flaky, payment.provider_order_id), /simulated connection loss/);
  assert.equal(JSON.stringify([store.allocations, store.bookings, store.payments]), before);
});

// ---- races ----------------------------------------------------------------------------------

/** create-booking's transaction for a new booking B, faithfully ordered: the booking INSERT is
 *  uncommitted (invisible to others), then allocateSimulators() takes the simulators lock. */
async function createBookingB(store: FakePaymentDbStore, ticksBefore: number): Promise<{ booking: FakeBookingRow; allocated: boolean }> {
  for (let i = 0; i < ticksBefore; i += 1) await Promise.resolve();
  const db = createFakePaymentDbClient(store);
  await db.query('BEGIN');
  const booking = seedBooking(store, { priceInr: '500.00', holdAllocations: 0, start: SLOT_START, end: SLOT_END });
  store.uncommittedBookingIds.add(booking.id);
  const allocation = await allocateSimulators(db, {
    bookingId: booking.id, requirement: { static: 1, motion: 0 }, scheduledStartAt: SLOT_START, scheduledEndAt: SLOT_END, holdMinutes: 15,
  });
  if (!allocation) {
    store.bookings.splice(store.bookings.indexOf(booking), 1);
  }
  await db.query(allocation ? 'COMMIT' : 'ROLLBACK');
  store.uncommittedBookingIds.delete(booking.id);
  return { booking, allocated: allocation !== null };
}

test('race: a late payment confirmation and a brand-new booking fight for the LAST static rig — exactly one wins, never both, at every interleaving', async () => {
  const oneRig = [{ id: 'sim-S1', code: 'S1', simulator_type: 'static' as const }];
  const seen = new Set<string>();
  for (const lateFirst of [true, false]) {
    for (let ticks = 0; ticks <= 14; ticks += 1) {
      clockAt(T0);
      const store = createFakePaymentDbStore(oneRig);
      const { booking: a, payment, db } = await pendingWithPayment(store);
      clockAt(T0 + 16 * MIN);

      const confirmA = () => pay(db, payment.provider_order_id);
      const bookB = () => createBookingB(store, lateFirst ? ticks : 0);
      const [resultA, resultB] = await (async () => {
        if (lateFirst) {
          const pa = confirmA();
          return Promise.all([pa, bookB()]);
        }
        const pb = bookB();
        const pa = (async () => { for (let i = 0; i < ticks; i += 1) await Promise.resolve(); return confirmA(); })();
        return Promise.all([pa, pb]);
      })();

      assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), [], `double booking at lateFirst=${lateFirst} ticks=${ticks}`);
      const aConfirmed = resultA.outcome === 'confirmed_after_reallocation';
      assert.notEqual(aConfirmed, resultB.allocated, `exactly one of {A confirmed, B allocated}: lateFirst=${lateFirst} ticks=${ticks}`);
      assert.equal(store.payments[0].payment_status, 'paid');
      if (aConfirmed) {
        assert.equal(store.bookings.find((x) => x.id === a.id)!.status, 'confirmed');
      } else {
        assert.equal(resultA.outcome, 'refund_required');
        assert.equal(store.bookings.find((x) => x.id === a.id)!.status, 'cancelled');
        assert.equal(store.payments[0].metadata?.refundRequired, true);
      }
      seen.add(aConfirmed ? 'A-won' : 'B-won');
    }
  }
  assert.deepEqual([...seen].sort(), ['A-won', 'B-won'], 'the sweep exercised both winners');
});

test('race: two payments for two different pending bookings competing for one rig — one is confirmed, the other flagged for refund', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore([{ id: 'sim-S1', code: 'S1', simulator_type: 'static' }]);
  const a = await pendingWithPayment(store, { simulatorId: 'sim-S1' });
  const b = await pendingWithPayment(store, { simulatorId: 'sim-S1' }); // both holds on S1 — only possible because one expired first
  // Make A's hold lapse first, then B's hold get created "later" on the same rig.
  store.allocations.find((x) => x.booking_id === a.booking.id)!.hold_expires_at = new Date(T0 + 15 * MIN);
  store.allocations.find((x) => x.booking_id === b.booking.id)!.hold_expires_at = new Date(T0 + 40 * MIN);
  clockAt(T0 + 16 * MIN);

  const [ra, rb] = await Promise.all([pay(a.db, a.payment.provider_order_id), pay(createFakePaymentDbClient(store), b.payment.provider_order_id)]);

  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), []);
  assert.deepEqual([ra.outcome, rb.outcome].sort(), ['confirmed', 'refund_required'].sort());
  assert.equal(rb.outcome, 'confirmed', "B's hold was valid, so B keeps its rig; A cannot take it");
});

// ---- other terminal states ------------------------------------------------------------------

test('payment for an already-cancelled booking: recorded PAID + refundRequired, booking stays cancelled, no allocation resurrected', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await pendingWithPayment(store);
  store.bookings[0].status = 'cancelled';
  store.allocations.forEach((a) => Object.assign(a, { allocation_status: 'released', hold_expires_at: null }));

  const result = await pay(db, payment.provider_order_id);

  assert.equal(result.outcome, 'refund_required');
  assert.equal(store.payments[0].payment_status, 'paid');
  assert.equal(store.payments[0].metadata?.reason, 'booking_cancelled');
  assert.equal(store.bookings[0].status, 'cancelled');
  assert.deepEqual(live(store, booking.id), []);
});
