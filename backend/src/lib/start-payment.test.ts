import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import {
  BookingAlreadyPaidError,
  BookingNotFoundError,
  BookingNotPayableError,
  CheckoutWindowClosedError,
  HoldExpiredError,
  PaymentEnvironmentMismatchError,
  PaymentProviderError,
  PaymentProviderOrderNotFoundError,
  PaymentStartInProgressError,
  SimulatorCapacityUnavailableError,
} from './payment-errors';
import { lockBookingForPayment, markPaymentPaid } from './payment-repository';
import { startPayment, type StartPaymentInput } from './start-payment';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  findDoubleBookings,
  seedBooking,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';
import { ScriptedProvider } from './test-support/scripted-provider';
import { lockSimulatorInventory, type DbClient } from './allocate-simulators';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0); // 2026-09-25 06:00Z
const MIN = 60_000;

afterEach(() => mock.timers.reset());

function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

function baseInput(bookingId: string, overrides: Partial<StartPaymentInput> = {}): StartPaymentInput {
  let n = 0;
  return {
    bookingId,
    environment: 'SANDBOX',
    checkoutHoldMinutes: 20,
    description: 'Solo Static 30 min',
    generateProviderOrderId: () => `order-${(n += 1)}`,
    ...overrides,
  };
}

/** A pending booking whose 15-minute booking hold was taken at T0. Session is tomorrow. */
function setup(overrides: { start?: Date; holdMinutes?: number; bookingEnvironment?: 'SANDBOX' | 'PRODUCTION' | null } = {}) {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    bookingEnvironment: overrides.bookingEnvironment,
    priceInr: '999.00',
    holdExpiresAt: new Date(T0 + (overrides.holdMinutes ?? 15) * MIN),
    start: overrides.start ?? new Date(T0 + 24 * 60 * MIN),
    simulatorIds: ['sim-S1'],
  });
  const db = createFakePaymentDbClient(store);
  const provider = new ScriptedProvider(db);
  return { store, booking, db, provider };
}

const holds = (store: FakePaymentDbStore, bookingId: string) =>
  store.allocations.filter((a) => a.booking_id === bookingId && a.allocation_status === 'hold');

test('provider HTTP happens OUTSIDE any DB transaction, after TX1 committed and before TX2', async () => {
  const { store, booking, db, provider } = setup();
  let paymentDuringCall: { status: string; redirect: unknown } | undefined;
  provider.onCreate = async () => {
    const row = store.payments[0];
    paymentDuringCall = { status: row.payment_status, redirect: (row.metadata as { checkout?: unknown } | null)?.checkout };
  };

  await startPayment(db, provider, baseInput(booking.id));

  assert.deepEqual(provider.callsInsideTransaction, [false], 'no transaction open while waiting on the provider');
  assert.deepEqual(paymentDuringCall, { status: 'created', redirect: undefined }, 'TX1 already committed the reserved attempt');
  assert.equal(store.payments[0].payment_status, 'pending', 'TX2 then persisted the response');
});

test('no row/simulator locks are held while the provider call is in flight (a second connection can take them)', async () => {
  const { store, booking, db, provider } = setup();
  let probed = false;
  provider.onCreate = async () => {
    const other = createFakePaymentDbClient(store);
    const probe = (async () => {
      await other.query('BEGIN');
      await lockBookingForPayment(other, booking.id);
      await lockSimulatorInventory(other);
      await other.query('COMMIT');
      probed = true;
    })();
    await Promise.race([probe, new Promise((_, reject) => setTimeout(() => reject(new Error('locks still held during provider call')), 1000).unref())]);
  };
  await startPayment(db, provider, baseInput(booking.id));
  assert.ok(probed);
});

test('TX1 lock order is booking -> simulators -> allocations; TX2 only locks the payment', async () => {
  const { booking, db, provider } = setup();
  await startPayment(db, provider, baseInput(booking.id));
  assert.deepEqual(db.lockLog, ['booking', 'simulators', 'allocations', 'payment']);
});

test('amount comes from the booking (exact NUMERIC string), never the caller; environment is recorded in metadata', async () => {
  const { store, booking, db, provider } = setup();
  const result = await startPayment(db, provider, baseInput(booking.id));
  assert.equal(provider.createCalls[0].amountInr, '999.00');
  assert.equal(provider.createCalls[0].currency, 'INR');
  assert.equal(result.amountInr, '999.00');
  assert.equal(store.payments[0].metadata?.environment, 'SANDBOX');
  assert.equal(result.redirectUrl, `https://pay.test/${result.providerOrderId}`);
});

test('hold is extended once to now + checkoutHoldMinutes and the provider order expiry is aligned with it', async () => {
  const { store, booking, db, provider } = setup();
  const result = await startPayment(db, provider, baseInput(booking.id, { checkoutHoldMinutes: 20 }));

  const expected = new Date(T0 + 20 * MIN);
  assert.deepEqual(holds(store, booking.id).map((a) => a.hold_expires_at), [expected]);
  assert.equal(provider.createCalls[0].expireAfterSeconds, 20 * 60);
  assert.deepEqual(result.expiresAt, expected);
  assert.equal(store.payments[0].metadata?.holdExtended, true);
  assert.equal(store.payments[0].metadata?.orderExpiresAt, expected.toISOString());
});

test('the checkout TTL is configurable, and a hold is never SHORTENED by a smaller TTL', async () => {
  const a = setup({ holdMinutes: 15 });
  const resultA = await startPayment(a.db, a.provider, baseInput(a.booking.id, { checkoutHoldMinutes: 30 }));
  assert.deepEqual(resultA.expiresAt, new Date(T0 + 30 * MIN));

  const b = setup({ holdMinutes: 15 });
  const resultB = await startPayment(b.db, b.provider, baseInput(b.booking.id, { checkoutHoldMinutes: 5 }));
  assert.deepEqual(resultB.expiresAt, new Date(T0 + 15 * MIN), 'existing longer hold is kept');
  assert.equal(b.provider.createCalls[0].expireAfterSeconds, 15 * 60);
});

test('the extension is bounded: a hold never runs past the session start', async () => {
  const { store, booking, db, provider } = setup({ start: new Date(T0 + 18 * MIN) });
  const result = await startPayment(db, provider, baseInput(booking.id, { checkoutHoldMinutes: 30 }));
  assert.deepEqual(result.expiresAt, new Date(T0 + 18 * MIN));
  assert.deepEqual(holds(store, booking.id)[0].hold_expires_at, new Date(T0 + 18 * MIN));
});

test('too little time left before the session (or an already-started session) closes checkout — no order is created', async () => {
  const soon = setup({ start: new Date(T0 + 30_000) });
  await assert.rejects(() => startPayment(soon.db, soon.provider, baseInput(soon.booking.id)), CheckoutWindowClosedError);
  assert.equal(soon.provider.createCalls.length, 0);
  assert.equal(soon.store.payments.length, 0);
  assert.equal(soon.db.inTransaction(), false);

  const started = setup({ start: new Date(T0 - MIN) });
  await assert.rejects(() => startPayment(started.db, started.provider, baseInput(started.booking.id)), CheckoutWindowClosedError);
});

test('double click, sequential: the second call reuses the live attempt — one order, one payment row, no second provider call', async () => {
  const { store, booking, db, provider } = setup();
  const first = await startPayment(db, provider, baseInput(booking.id));
  clockAt(T0 + 5_000);
  const second = await startPayment(db, provider, baseInput(booking.id));

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.providerOrderId, first.providerOrderId);
  assert.equal(second.redirectUrl, first.redirectUrl);
  assert.equal(provider.createCalls.length, 1);
  assert.equal(store.payments.length, 1);
});

test('double click, concurrent: while the first call is still at the provider, the second is refused — never a second live order', async () => {
  const { store, booking, db, provider } = setup();
  let release!: () => void;
  provider.createGate = new Promise<void>((resolve) => (release = resolve));
  const db2 = createFakePaymentDbClient(store);

  const first = startPayment(db, provider, baseInput(booking.id));
  await new Promise((resolve) => setImmediate(resolve)); // first is now parked inside the provider call
  assert.equal(provider.createCalls.length, 1);

  await assert.rejects(() => startPayment(db2, provider, baseInput(booking.id)), PaymentStartInProgressError);
  release();
  const result = await first;

  assert.equal(provider.createCalls.length, 1);
  assert.equal(store.payments.length, 1);
  assert.equal(result.reused, false);
  assert.equal(store.payments[0].payment_status, 'pending');
});

test('many simultaneous starts on separate connections create exactly one provider order', async () => {
  const { store, booking, provider } = setup();
  const attempts = Array.from({ length: 6 }, () => startPayment(createFakePaymentDbClient(store), provider, baseInput(booking.id)).then(
    (r) => r.reused ? 'reused' : 'created',
    (e) => (e instanceof PaymentStartInProgressError ? 'in-progress' : `other:${(e as Error).message}`),
  ));
  const outcomes = await Promise.all(attempts);
  assert.equal(outcomes.filter((o) => o === 'created').length, 1);
  assert.ok(outcomes.every((o) => o === 'created' || o === 'reused' || o === 'in-progress'), outcomes.join());
  assert.equal(provider.createCalls.length, 1);
  assert.equal(store.payments.length, 1);
});

test('definite provider rejection (4xx): the attempt is failed, the hold is kept, a retry gets a NEW order but the hold is NOT extended again', async () => {
  const { store, booking, db, provider } = setup();
  provider.createError = (i) => (i === 0 ? new PaymentProviderError('rejected (HTTP 400)', true, 400) : undefined);

  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentProviderError);
  assert.equal(store.payments[0].payment_status, 'failed');
  assert.match(String(store.payments[0].failure_reason), /provider_rejected_order/);
  const extendedTo = new Date(T0 + 20 * MIN);
  assert.deepEqual(holds(store, booking.id)[0].hold_expires_at, extendedTo);

  clockAt(T0 + 2 * MIN);
  const retry = await startPayment(db, provider, baseInput(booking.id, { generateProviderOrderId: () => 'order-retry' }));
  assert.equal(retry.providerOrderId, 'order-retry');
  assert.deepEqual(holds(store, booking.id)[0].hold_expires_at, extendedTo, 'hold extended only once');
  assert.equal(provider.createCalls[1].expireAfterSeconds, 18 * 60, 'order expiry follows the remaining hold');
  assert.equal(store.payments.filter((p) => p.payment_status === 'pending').length, 1);
});

test('ambiguous provider failure (timeout/5xx): the attempt stays open; a prompt retry is refused; after the in-flight window a provider "order not found" clears it and a new attempt starts', async () => {
  const { store, booking, db, provider } = setup();
  provider.createError = (i) => (i === 0 ? new PaymentProviderError('timeout', false) : undefined);
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentProviderError);
  assert.equal(store.payments[0].payment_status, 'created', 'must not assume the order does not exist');

  clockAt(T0 + 10_000);
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentStartInProgressError);
  assert.equal(provider.createCalls.length, 1);

  clockAt(T0 + 3 * MIN);
  provider.statuses.set('order-1', new PaymentProviderOrderNotFoundError());
  const result = await startPayment(db, provider, baseInput(booking.id, { generateProviderOrderId: () => 'order-fresh' }));
  assert.equal(result.providerOrderId, 'order-fresh');
  assert.equal(store.payments.find((p) => p.provider_order_id === 'order-1')!.payment_status, 'failed');
  assert.deepEqual(provider.callsInsideTransaction.every((x) => x === false), true, 'status lookup also ran outside a transaction');
});

test('orphaned attempt that turns out PAID at the provider: it is confirmed and no second order is started', async () => {
  const { store, booking, db, provider } = setup();
  provider.createError = (i) => (i === 0 ? new PaymentProviderError('timeout', false) : undefined);
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentProviderError);

  clockAt(T0 + 3 * MIN);
  provider.statuses.set('order-1', { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX1' });
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), BookingAlreadyPaidError);

  assert.equal(store.payments[0].payment_status, 'paid');
  assert.equal(store.bookings[0].status, 'confirmed');
  assert.equal(provider.createCalls.length, 1);
});

test('orphaned attempt still PENDING at the provider blocks a new order (never two live orders)', async () => {
  const { store, booking, db, provider } = setup();
  provider.createError = (i) => (i === 0 ? new PaymentProviderError('timeout', false) : undefined);
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentProviderError);

  clockAt(T0 + 3 * MIN);
  provider.statuses.set('order-1', { outcome: 'PENDING' });
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentStartInProgressError);
  assert.equal(provider.createCalls.length, 1);
  assert.equal(store.payments.length, 1);
});

test('lapsed hold on the FIRST start is re-established when capacity is free; the new hold carries the checkout TTL', async () => {
  const { store, booking, db, provider } = setup({ holdMinutes: 15 });
  clockAt(T0 + 16 * MIN);
  const result = await startPayment(db, provider, baseInput(booking.id));

  const live = holds(store, booking.id);
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].hold_expires_at, new Date(T0 + 36 * MIN));
  assert.equal(store.allocations.filter((a) => a.allocation_status === 'released').length, 1, 'the obsolete hold is released, not left behind');
  assert.equal(store.payments[0].metadata?.holdReestablished, true);
  assert.equal(result.reused, false);
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), []);
});

test('lapsed hold whose capacity was taken by someone else: start is refused, nothing is double-booked, no order is created', async () => {
  const { store, booking, db, provider } = setup({ holdMinutes: 15 });
  // Both static rigs are confirmed to other bookings for the same slot.
  seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: ['sim-S1'], start: booking.scheduled_start_at, end: booking.scheduled_end_at });
  seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: ['sim-S2'], start: booking.scheduled_start_at, end: booking.scheduled_end_at });
  clockAt(T0 + 16 * MIN);

  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), SimulatorCapacityUnavailableError);
  assert.equal(provider.createCalls.length, 0);
  assert.equal(store.payments.length, 0);
  assert.deepEqual(findDoubleBookings(store, new Date(T0 + 16 * MIN)), []);
  assert.equal(holds(store, booking.id).length, 1, 'rolled back: the original (expired) hold row is untouched');
});

test('once the one extension is spent, a lapsed hold is final (HoldExpiredError) — retries cannot keep re-grabbing capacity', async () => {
  const { booking, db, provider } = setup();
  provider.createError = (i) => (i === 0 ? new PaymentProviderError('rejected', true, 400) : undefined);
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentProviderError);

  clockAt(T0 + 21 * MIN); // the extended hold (T0+20) has now lapsed
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), HoldExpiredError);
  assert.equal(provider.createCalls.length, 1);
});

test('booking must exist, be pending, and not already be paid', async () => {
  const { store, booking, db, provider } = setup();
  await assert.rejects(() => startPayment(db, provider, baseInput('nope')), BookingNotFoundError);

  store.bookings[0].status = 'confirmed';
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), BookingNotPayableError);
  store.bookings[0].status = 'cancelled';
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), BookingNotPayableError);

  store.bookings[0].status = 'pending';
  const pay = createFakePaymentDbClient(store);
  await pay.query('BEGIN');
  store.payments.push({
    id: 'p-paid', booking_id: booking.id, provider: 'phonepe', provider_order_id: 'x', provider_transaction_id: null,
    amount_inr: '999.00', currency: 'INR', payment_status: 'created', failure_reason: null, metadata: null,
    created_at: new Date(), updated_at: new Date(), paid_at: null,
  });
  await markPaymentPaid(pay, 'p-paid', 'tx');
  await pay.query('COMMIT');
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), BookingAlreadyPaidError);
  assert.equal(provider.createCalls.length, 0);
  assert.equal(db.inTransaction(), false, 'every failure path rolled back');
});

test('failures inside TX1 roll back completely: no payment row, hold untouched', async () => {
  const { store, booking, db, provider } = setup();
  const flaky: DbClient = {
    query: async (text, params) => {
      if (/^INSERT INTO payments/i.test(text.trim())) {
        throw new Error('simulated connection loss');
      }
      return db.query(text, params);
    },
  };
  await assert.rejects(() => startPayment(flaky, provider, baseInput(booking.id)), /simulated connection loss/);
  assert.equal(store.payments.length, 0);
  assert.deepEqual(holds(store, booking.id)[0].hold_expires_at, new Date(T0 + 15 * MIN), 'extension rolled back with it');
  assert.equal(provider.createCalls.length, 0);
});

// ---------------------------------------------------------------- booking/payment environment

test('environment: a SANDBOX booking gets a SANDBOX attempt (typed column + metadata mirror)', async () => {
  const { store, booking, db, provider } = setup();
  await startPayment(db, provider, baseInput(booking.id));
  assert.equal(store.payments[0].payment_environment, 'SANDBOX');
  assert.equal(store.payments[0].metadata?.paymentEnvironment, 'SANDBOX');
  assert.equal(store.payments[0].metadata?.environment, 'SANDBOX');
});

test('environment: a transitional NULL booking is accepted as legacy SANDBOX', async () => {
  const { store, booking, db, provider } = setup({ bookingEnvironment: null });
  await startPayment(db, provider, baseInput(booking.id));
  assert.equal(store.payments[0].payment_environment, 'SANDBOX');
});

test('environment: a PRODUCTION booking is rejected by a SANDBOX start — nothing written, hold untouched, no provider call', async () => {
  const { store, booking, db, provider } = setup({ bookingEnvironment: 'PRODUCTION' });
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentEnvironmentMismatchError);
  assert.equal(store.payments.length, 0);
  assert.deepEqual(holds(store, booking.id)[0].hold_expires_at, new Date(T0 + 15 * MIN));
  assert.equal(provider.createCalls.length + provider.statusCalls.length, 0);
  assert.equal(db.inTransaction(), false);
});

test('environment: a NULL booking never matches a PRODUCTION start', async () => {
  const { store, booking, db, provider } = setup({ bookingEnvironment: null });
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id, { environment: 'PRODUCTION' })), PaymentEnvironmentMismatchError);
  assert.equal(store.payments.length, 0);
});

test('environment: an open PRODUCTION attempt on a sandbox booking is never reused nor queried with the sandbox provider', async () => {
  const { store, booking, db, provider } = setup();
  await startPayment(db, provider, baseInput(booking.id));
  store.payments[0].payment_environment = 'PRODUCTION';
  await assert.rejects(() => startPayment(db, provider, baseInput(booking.id)), PaymentEnvironmentMismatchError);
  assert.equal(provider.createCalls.length, 1);
  assert.equal(provider.statusCalls.length, 0);
  assert.equal(store.payments.length, 1);
});

test('environment: a missing/unknown environment input is refused before any DB work', async () => {
  const { store, booking, db, provider } = setup();
  for (const environment of [undefined, '', 'sandbox', 'LIVE']) {
    await assert.rejects(() => startPayment(db, provider, baseInput(booking.id, { environment: environment as never })), /environment must be SANDBOX or PRODUCTION/);
  }
  assert.equal(store.payments.length, 0);
  assert.deepEqual(db.lockLog, []);
});
