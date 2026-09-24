import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { PaymentProviderError } from './payment-errors';
import { createPaymentAttempt, mergePaymentMetadata } from './payment-repository';
import { reconcilePendingPayments } from './reconcile-pending-payments';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  findDoubleBookings,
  seedBooking,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';
import { ScriptedProvider } from './test-support/scripted-provider';
import { createHandler, createReconcileHandler, RECONCILER_ENVIRONMENT } from '../handlers/payment-reconcile';
import { RECONCILER_ENVIRONMENT as PRODUCTION_RECONCILER_ENVIRONMENT } from '../handlers/payment-reconcile-production';
import type { DbClient } from './allocate-simulators';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const SLOT = { start: new Date(T0 + 24 * 60 * MIN), end: new Date(T0 + 24 * 60 * MIN + 30 * MIN) };

afterEach(() => mock.timers.reset());

function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

/** A pending booking (hold expires 15 min after T0) with one open PhonePe attempt that has a live checkout. */
async function openAttempt(store: FakePaymentDbStore, orderId: string, opts: { simulatorId?: string; holdMinutes?: number } = {}) {
  const booking = seedBooking(store, {
    priceInr: '999.00',
    simulatorIds: [opts.simulatorId ?? 'sim-S1'],
    holdExpiresAt: new Date(T0 + (opts.holdMinutes ?? 15) * MIN),
    ...SLOT,
  });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: orderId,
    amountInr: '999.00',
    metadata: { checkout: { redirectUrl: `https://pay.test/${orderId}` } },
  });
  return { booking, payment };
}

const success = (tx: string) => ({ outcome: 'SUCCESS' as const, amountInr: '999.00', currency: 'INR', providerTransactionId: tx });

function setup() {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);
  return { store, db, provider: new ScriptedProvider(db) };
}

test('pending -> still pending: nothing changes but the rotation marker', async () => {
  const { store, db, provider } = setup();
  const { booking, payment } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', { outcome: 'PENDING' });

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { still_pending: 1 });
  const stored = store.payments.find((p) => p.id === payment.id)!;
  assert.equal(stored.payment_status, 'pending');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
  assert.deepEqual(store.allocations.map((a) => a.allocation_status), ['hold']);
});

test('pending -> paid: payment PAID, booking CONFIRMED, allocation CONFIRMED', async () => {
  const { store, db, provider } = setup();
  const { booking, payment } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', success('TX1'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { confirmed: 1 });
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  assert.deepEqual(store.allocations.map((a) => a.allocation_status), ['confirmed']);
});

test('pending -> failed: only the payment fails; the booking keeps its hold', async () => {
  const { store, db, provider } = setup();
  const { booking, payment } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', { outcome: 'FAILED', failureReason: 'PAYMENT_ERROR' });

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { failed: 1 });
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'failed');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
});

test('selection: terminal, mock-provider and no-live-checkout attempts are skipped without any provider call', async () => {
  const { store, db, provider } = setup();
  for (const [orderId, status] of [['ord-paid', 'paid'], ['ord-failed', 'failed'], ['ord-expired', 'expired'], ['ord-refunded', 'refunded']] as const) {
    const { payment } = await openAttempt(store, orderId);
    const row = store.payments.find((p) => p.id === payment.id)!;
    row.payment_status = status;
    if (status === 'paid' || status === 'refunded') row.paid_at = new Date();
  }
  const noCheckout = seedBooking(store, { priceInr: '999.00', ...SLOT });
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: noCheckout.id, provider: 'phonepe', providerOrderId: 'ord-nocheckout', amountInr: '999.00' });
  const mockBooking = seedBooking(store, { priceInr: '999.00', ...SLOT });
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: mockBooking.id, provider: 'mock', providerOrderId: 'ord-mock', amountInr: '999.00', metadata: { checkout: { redirectUrl: 'x' } } });
  await openAttempt(store, 'ord-open');
  provider.statuses.set('ord-open', { outcome: 'PENDING' });

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(provider.statusCalls, ['ord-open'], 'only the open PhonePe attempt with a live checkout is queried');
  assert.equal(summary.scanned, 1);
});

test('terminal payment is never queried again once a run has settled it', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', success('TX1'));

  await reconcilePendingPayments(db, provider, 'SANDBOX');
  const second = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.equal(provider.statusCalls.length, 1, 'PhonePe was asked exactly once');
  assert.equal(second.scanned, 0);
});

test('idempotent repeated runs: still-pending stays pending; repeated success never double-confirms or double-allocates', async () => {
  const { store, db, provider } = setup();
  const { booking } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', { outcome: 'PENDING' });
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  assert.equal(store.payments.length, 1, 'no new payment/PhonePe order is ever created');
  assert.equal(provider.createCalls.length, 0);

  provider.statuses.set('ord-1', success('TX1'));
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  const snapshot = JSON.stringify([store.payments, store.bookings, store.allocations]);
  // Force the settled attempt back into view to prove even a stray re-run is a no-op.
  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');
  assert.equal(summary.scanned, 0);
  assert.equal(JSON.stringify([store.payments, store.bookings, store.allocations]), snapshot);
  assert.equal(store.allocations.filter((a) => a.booking_id === booking.id).length, 1);
  assert.equal(store.payments[0].amount_inr, '999.00', 'amount unchanged');
});

test('one failing item does not abort the batch; only class names/codes are reported', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  await openAttempt(store, 'ord-b', { simulatorId: 'sim-S2' });
  await openAttempt(store, 'ord-c', { simulatorId: 'sim-M1' });
  provider.statuses.set('ord-a', success('TXA'));
  provider.statuses.set('ord-b', new PaymentProviderError('PhonePe order status failed (HTTP 503) secret-token-123', false, 503));
  provider.statuses.set('ord-c', success('TXC'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { confirmed: 2, error: 1 });
  assert.equal(summary.hadUnexpectedError, false);
  assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 2);
  const errored = summary.items.find((i) => i.result === 'error')!;
  assert.equal(errored.error, 'payment_provider_error');
  assert.equal(JSON.stringify(summary).includes('secret-token-123'), false, 'no provider message text leaks into the summary');
});

test('an unexpected (non-domain) error stops the batch: no further provider calls, rest deferred, DB flagged for reset', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  await openAttempt(store, 'ord-b', { simulatorId: 'sim-S2' });
  await openAttempt(store, 'ord-c', { simulatorId: 'sim-M1' });
  provider.statuses.set('ord-a', new Error('connection terminated'));
  provider.statuses.set('ord-b', success('TXB'));
  provider.statuses.set('ord-c', success('TXC'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { error: 1 });
  assert.equal(summary.hadUnexpectedError, true);
  assert.equal(summary.processed, 1);
  assert.equal(summary.deferred, 2);
  assert.equal(provider.statusCalls.length, 1, 'no provider call after the unexpected error');
  assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 0);
});

test('handler resets the DB connection after an unexpected error stopped the batch', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  provider.statuses.set('ord-a', new Error('connection terminated'));
  let resets = 0;
  const handler = createHandler({ getDb: async () => db, resetDb: () => { resets += 1; }, getProvider: async () => provider, env: {} });
  const log = mock.method(console, 'log', () => {});
  try {
    const summary = await handler({});
    assert.equal(summary.hadUnexpectedError, true);
    assert.equal(resets, 1);
  } finally {
    log.mock.restore();
  }
});

test('error rotation: expected provider and domain errors are rotated to the back, like still-pending', async () => {
  const { store, db, provider } = setup();
  const a = await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  const b = await openAttempt(store, 'ord-b', { simulatorId: 'sim-S2' });
  const c = await openAttempt(store, 'ord-c', { simulatorId: 'sim-M1' });
  clockAt(T0 + 5 * MIN);
  provider.statuses.set('ord-a', new PaymentProviderError('HTTP 503 secret-token-123', false, 503));
  provider.statuses.set('ord-b', { outcome: 'SUCCESS', amountInr: '1.00', currency: 'INR', providerTransactionId: 'TXB' }); // amount mismatch -> domain error
  provider.statuses.set('ord-c', { outcome: 'PENDING' });

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.equal(summary.hadUnexpectedError, false);
  assert.equal(summary.counts.error, 2);
  for (const { payment } of [a, b, c]) {
    const stored = store.payments.find((p) => p.id === payment.id)!;
    assert.equal(stored.metadata?.reconcileCheckedAt, new Date(T0 + 5 * MIN).toISOString(), `${stored.provider_order_id} rotated`);
    assert.equal(stored.payment_status === 'paid', false);
  }
  assert.equal(JSON.stringify(store.payments).includes('secret-token-123'), false, 'provider message is not persisted');
});

test('no starvation: >25 candidates, persistent errors in the first batch cannot keep later candidates from being reached', async () => {
  const { store, db, provider } = setup();
  const sims = ['sim-S1', 'sim-S2', 'sim-M1', 'sim-M2'];
  const all: string[] = [];
  for (let i = 0; i < 30; i++) {
    const orderId = `ord-${String(i).padStart(2, '0')}`;
    all.push(orderId);
    await openAttempt(store, orderId, { simulatorId: sims[i % sims.length] });
    provider.statuses.set(orderId, new PaymentProviderError('provider down', false, 503)); // persistent failure
  }
  clockAt(T0 + 5 * MIN);
  const first = await reconcilePendingPayments(db, provider, 'SANDBOX'); // default batch = 25
  assert.equal(first.processed, 25);
  assert.equal(first.counts.error, 25);
  const failing = [...provider.statusCalls];
  const neverReached = all.filter((o) => !failing.includes(o));
  assert.equal(neverReached.length, 5);
  for (const o of neverReached) provider.statuses.set(o, { outcome: 'PENDING' }); // the 25 keep failing

  provider.statusCalls.length = 0;
  clockAt(T0 + 10 * MIN);
  const second = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(new Set(provider.statusCalls.slice(0, 5)), new Set(neverReached), 'run 2 reaches the five candidates run 1 never got to, first');
  assert.equal(second.counts.still_pending, 5);
});

test('no age cut-off: an open attempt older than 6h, 24h and 7 days is still reconciled and confirmed', async () => {
  for (const ageMinutes of [6 * 60 + 1, 24 * 60 + 1, 7 * 24 * 60]) {
    const { store, db, provider } = setup();
    const { booking, payment } = await openAttempt(store, 'ord-old', { holdMinutes: 24 * 60 * 30 });
    store.payments.find((p) => p.id === payment.id)!.created_at = new Date(T0 - ageMinutes * MIN);
    provider.statuses.set('ord-old', success('TX-OLD'));

    const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

    assert.equal(summary.scanned, 1, `selected at age ${ageMinutes} min`);
    assert.deepEqual(provider.statusCalls, ['ord-old']);
    assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid');
    assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  }
});

test('old open attempts still rotate: an attempt older than 24h that stays pending is checked again after newer ones', async () => {
  const { store, db, provider } = setup();
  const old = await openAttempt(store, 'ord-old', { simulatorId: 'sim-S1' });
  store.payments.find((p) => p.id === old.payment.id)!.created_at = new Date(T0 - 48 * 60 * MIN);
  await openAttempt(store, 'ord-new', { simulatorId: 'sim-S2' });
  provider.statuses.set('ord-old', { outcome: 'PENDING' });
  provider.statuses.set('ord-new', { outcome: 'PENDING' });

  clockAt(T0 + MIN);
  await reconcilePendingPayments(db, provider, 'SANDBOX', { batchSize: 1 });
  assert.deepEqual(provider.statusCalls, ['ord-old'], 'oldest-checked first');
  clockAt(T0 + 5 * MIN);
  await reconcilePendingPayments(db, provider, 'SANDBOX', { batchSize: 1 });
  assert.deepEqual(provider.statusCalls, ['ord-old', 'ord-new'], 'then the other one — no permanent head-of-line');
});

test('batch is bounded and rotates: least-recently-checked attempts go first', async () => {
  const { store, db, provider } = setup();
  const a = await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  await openAttempt(store, 'ord-b', { simulatorId: 'sim-S2' });
  await openAttempt(store, 'ord-c', { simulatorId: 'sim-M1' });

  const first = await reconcilePendingPayments(db, provider, 'SANDBOX', { batchSize: 2 });
  assert.equal(first.processed, 2);
  clockAt(T0 + 5 * MIN);
  await mergePaymentMetadata(db, a.payment.id, { reconcileCheckedAt: new Date().toISOString() }); // (already set by run 1; explicit for clarity)
  const second = await reconcilePendingPayments(db, provider, 'SANDBOX', { batchSize: 2 });

  assert.ok(second.items.some((i) => i.paymentId !== first.items[0].paymentId && i.paymentId !== first.items[1].paymentId), 'the attempt skipped in run 1 is reached in run 2');
});

test('stops starting new items when out of time and reports the deferred count', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-a', { simulatorId: 'sim-S1' });
  await openAttempt(store, 'ord-b', { simulatorId: 'sim-S2' });
  let calls = 0;
  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX', { hasTimeLeft: () => calls++ < 1 });
  assert.equal(summary.processed, 1);
  assert.equal(summary.deferred, 1);
});

test('late payment after expired hold, capacity available: re-allocated and confirmed', async () => {
  const { store, db, provider } = setup();
  const { booking } = await openAttempt(store, 'ord-1');
  clockAt(T0 + 17 * MIN);
  provider.statuses.set('ord-1', success('TX1'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { confirmed_after_reallocation: 1 });
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  assert.deepEqual(findDoubleBookings(store), []);
});

test('late payment after expired hold, capacity unavailable: PAID + refundRequired, booking cancelled, no double-booking', async () => {
  const { store, db, provider } = setup();
  const { booking, payment } = await openAttempt(store, 'ord-1');
  clockAt(T0 + 17 * MIN);
  for (const sim of ['sim-S1', 'sim-S2']) {
    seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: [sim], ...SLOT });
  }
  provider.statuses.set('ord-1', success('TX1'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { paid_refund_required: 1 });
  const stored = store.payments.find((p) => p.id === payment.id)!;
  assert.equal(stored.payment_status, 'paid');
  assert.equal(stored.metadata?.refundRequired, true);
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'cancelled');
  assert.deepEqual(findDoubleBookings(store), []);
});

test('second successful payment after the booking is already paid: truth preserved, manual review, no double allocation', async () => {
  const { store, db, provider } = setup();
  const { booking, payment: first } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', success('TX1'));
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  const allocationsBefore = JSON.stringify(store.allocations);

  // A historical second order for the same booking is still open at PhonePe and now reports success.
  const second = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: 'ord-2',
    amountInr: '999.00',
    metadata: { checkout: { redirectUrl: 'https://pay.test/ord-2' } },
  });
  provider.statuses.set('ord-2', success('TX2'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { duplicate_paid_refund_required: 1 });
  const storedSecond = store.payments.find((p) => p.id === second.id)!;
  assert.equal(storedSecond.payment_status, 'paid', 'PhonePe truth is recorded');
  assert.equal(storedSecond.provider_transaction_id, 'TX2');
  assert.equal(storedSecond.duplicate_of_payment_id, first.id);
  assert.equal(storedSecond.metadata?.refundRequired, true);
  assert.equal(storedSecond.metadata?.manualReview, true);
  assert.equal(storedSecond.metadata?.reason, 'duplicate_payment_booking_already_paid');
  assert.equal('refunded' in (storedSecond.metadata ?? {}), false, 'no refund is claimed');
  assert.notEqual(storedSecond.payment_status, 'refunded');
  const storedFirst = store.payments.find((p) => p.id === first.id)!;
  assert.equal(storedFirst.payment_status, 'paid');
  assert.equal(storedFirst.metadata?.refundRequired, undefined, 'the confirming payment is untouched');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  assert.equal(JSON.stringify(store.allocations), allocationsBefore, 'no double allocation');

  // Repeated run: settled, never re-queried.
  const again = await reconcilePendingPayments(db, provider, 'SANDBOX');
  assert.equal(again.scanned, 0);
  assert.equal(provider.statusCalls.filter((o) => o === 'ord-2').length, 1);
});

/** Confirms the booking's first payment through reconciliation, then adds a second open order. */
async function paidBookingWithSecondOrder(store: FakePaymentDbStore, db: ReturnType<typeof createFakePaymentDbClient>, provider: ScriptedProvider, secondOrder: string) {
  const { booking, payment: first } = await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', success('TX1'));
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  const second = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: secondOrder,
    amountInr: '999.00',
    metadata: { checkout: { redirectUrl: `https://pay.test/${secondOrder}` } },
  });
  return { booking, first, second };
}

test('primary REFUNDED, later success: still recorded as a duplicate (manual refund), booking/allocations never reconfirmed', async () => {
  const { store, db, provider } = setup();
  const { booking, first, second } = await paidBookingWithSecondOrder(store, db, provider, 'ord-2');
  store.payments.find((p) => p.id === first.id)!.payment_status = 'refunded'; // primary refunded afterwards
  const bookingBefore = JSON.stringify(store.bookings.find((b) => b.id === booking.id));
  const allocationsBefore = JSON.stringify(store.allocations);
  provider.statuses.set('ord-2', success('TX2'));

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { duplicate_paid_refund_required: 1 });
  const stored = store.payments.find((p) => p.id === second.id)!;
  assert.equal(stored.payment_status, 'paid');
  assert.equal(stored.duplicate_of_payment_id, first.id);
  assert.equal(stored.metadata?.refundRequired, true);
  assert.equal(store.payments.find((p) => p.id === first.id)!.payment_status, 'refunded', 'primary untouched');
  assert.equal(JSON.stringify(store.bookings.find((b) => b.id === booking.id)), bookingBefore, 'booking not reconfirmed');
  assert.equal(JSON.stringify(store.allocations), allocationsBefore, 'allocations not reconfirmed');
  assert.deepEqual(findDoubleBookings(store), []);
});

test('duplicate REFUNDED does not become a primary: a further success is a duplicate of the real primary', async () => {
  const { store, db, provider } = setup();
  const { booking, first, second } = await paidBookingWithSecondOrder(store, db, provider, 'ord-2');
  provider.statuses.set('ord-2', success('TX2'));
  await reconcilePendingPayments(db, provider, 'SANDBOX');
  store.payments.find((p) => p.id === second.id)!.payment_status = 'refunded'; // the duplicate gets refunded
  store.payments.find((p) => p.id === first.id)!.payment_status = 'refunded'; // and so is the primary: only duplicates remain paid/refunded

  const third = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: 'ord-3',
    amountInr: '999.00',
    metadata: { checkout: { redirectUrl: 'https://pay.test/ord-3' } },
  });
  provider.statuses.set('ord-3', success('TX3'));
  const allocationsBefore = JSON.stringify(store.allocations);

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(summary.counts, { duplicate_paid_refund_required: 1 });
  assert.equal(store.payments.find((p) => p.id === third.id)!.duplicate_of_payment_id, first.id, 'points at the primary, never at a duplicate');
  assert.equal(JSON.stringify(store.allocations), allocationsBefore);
  const primaries = store.payments.filter((p) => p.booking_id === booking.id && (p.payment_status === 'paid' || p.payment_status === 'refunded') && !p.duplicate_of_payment_id);
  assert.deepEqual(primaries.map((p) => p.id), [first.id], 'exactly one primary per booking, ever');
});

test('handler: runs a batch with env-bounded settings, returns the safe summary, drops the DB only on unexpected errors', async () => {
  const { store, db, provider } = setup();
  await openAttempt(store, 'ord-1');
  provider.statuses.set('ord-1', success('TX1'));
  let resets = 0;
  const handler = createHandler({ getDb: async () => db, resetDb: () => { resets += 1; }, getProvider: async () => provider, env: { RECONCILE_BATCH_SIZE: 'nonsense' } });
  const log = mock.method(console, 'log', () => {});
  try {
    const summary = await handler({}, { getRemainingTimeInMillis: () => 240_000 });
    assert.deepEqual(summary.counts, { confirmed: 1 });
    assert.equal(resets, 0);
  } finally {
    log.mock.restore();
  }

  const failing = createHandler({ getDb: async () => db, resetDb: () => { resets += 1; }, getProvider: async () => { throw new Error('no creds'); }, env: {} });
  const err = mock.method(console, 'error', () => {});
  try {
    await assert.rejects(() => failing({}), /no creds/);
    assert.equal(resets, 1);
  } finally {
    err.mock.restore();
  }
});

// ---------------------------------------------------------------- environment

/** An open attempt whose typed payment_environment is `env` ('NULL' = a NULL row, impossible after 007). */
async function openAttemptIn(store: FakePaymentDbStore, orderId: string, env: 'SANDBOX' | 'PRODUCTION' | 'NULL', simulatorId: string) {
  const { payment } = await openAttempt(store, orderId, { simulatorId });
  store.payments.find((p) => p.id === payment.id)!.payment_environment = env === 'NULL' ? null : env;
}

test('environment: a SANDBOX run reconciles only SANDBOX attempts, never NULL or PRODUCTION', async () => {
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  await openAttemptIn(store, 'ord-null', 'NULL', 'sim-S2');
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');

  const summary = await reconcilePendingPayments(db, provider, 'SANDBOX');

  assert.deepEqual(provider.statusCalls, ['ord-sb']);
  assert.equal(summary.scanned, 1);
  assert.equal(store.payments.find((p) => p.provider_order_id === 'ord-prod')!.metadata?.reconcileCheckedAt, undefined, 'PRODUCTION row untouched');
  assert.equal(store.payments.find((p) => p.provider_order_id === 'ord-null')!.metadata?.reconcileCheckedAt, undefined, 'NULL row untouched');
});

test('environment: a (hypothetical) PRODUCTION run selects only PRODUCTION, never NULL', async () => {
  const { store, db, provider } = setup();
  provider.environment = 'PRODUCTION';
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  await openAttemptIn(store, 'ord-null', 'NULL', 'sim-S2');
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');

  await reconcilePendingPayments(db, provider, 'PRODUCTION');

  assert.deepEqual(provider.statusCalls, ['ord-prod']);
});

test('environment: the run refuses to start when the provider is configured for another environment', async () => {
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  provider.environment = 'PRODUCTION';
  await assert.rejects(() => reconcilePendingPayments(db, provider, 'SANDBOX'), /configured for PRODUCTION, not SANDBOX/);
  assert.equal(provider.statusCalls.length, 0);
});

test('environment: the scheduled 5-minute handler explicitly reconciles SANDBOX', async () => {
  assert.equal(RECONCILER_ENVIRONMENT, 'SANDBOX');
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');
  const selects: unknown[][] = [];
  const spy: DbClient = {
    query: async (text: string, params: unknown[] = []) => {
      if (/payment_status IN \('created', 'pending'\)/.test(text) && /LIMIT \$2/.test(text)) selects.push(params);
      return db.query(text, params);
    },
  } as DbClient;
  const handler = createHandler({ getDb: async () => spy, resetDb: () => {}, getProvider: async () => provider, env: {} });
  const log = mock.method(console, 'log', () => {});
  try {
    await handler({});
  } finally {
    log.mock.restore();
  }
  assert.equal(selects.length, 1);
  assert.equal(selects[0][0], 'SANDBOX');
  assert.deepEqual(provider.statusCalls, ['ord-sb']);
});

test('environment: the scheduled handler fails closed if its PhonePe secret is not SANDBOX', async () => {
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  provider.environment = 'PRODUCTION';
  const handler = createHandler({ getDb: async () => db, resetDb: () => {}, getProvider: async () => provider, env: {} });
  const err = mock.method(console, 'error', () => {});
  try {
    await assert.rejects(() => handler({}));
  } finally {
    err.mock.restore();
  }
  assert.equal(provider.statusCalls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// PhonePe cutover Stage 2B: the PRODUCTION 5-minute fallback reconciler.
// ---------------------------------------------------------------------------------------------

/** Wraps a DB client to record the environment each reconciliation SELECT is bound to. */
function selectSpy(db: DbClient): { spy: DbClient; selects: unknown[][] } {
  const selects: unknown[][] = [];
  const spy = {
    query: async (text: string, params: unknown[] = []) => {
      if (/payment_status IN \('created', 'pending'\)/.test(text) && /LIMIT \$2/.test(text)) selects.push(params);
      return db.query(text, params);
    },
  } as DbClient;
  return { spy, selects };
}

test('production fallback: its entry file hard-codes PRODUCTION; the sandbox one stays SANDBOX', () => {
  assert.equal(PRODUCTION_RECONCILER_ENVIRONMENT, 'PRODUCTION');
  assert.equal(RECONCILER_ENVIRONMENT, 'SANDBOX');
  const src = require('node:fs').readFileSync(require.resolve('../handlers/payment-reconcile-production.ts'), 'utf8') as string;
  assert.match(src, /createReconcileHandler\(RECONCILER_ENVIRONMENT, defaultDeps\)/);
  assert.doesNotMatch(src, /process\.env/, 'no runtime environment variable can select the environment');
});

test('production fallback: reconciles only PRODUCTION rows (never SANDBOX or NULL), whatever the event says', async () => {
  const { store, db, provider } = setup();
  provider.environment = 'PRODUCTION';
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  await openAttemptIn(store, 'ord-null', 'NULL', 'sim-S2');
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');
  const { spy, selects } = selectSpy(db);
  const handler = createReconcileHandler('PRODUCTION', {
    getDb: async () => spy, resetDb: () => {}, getProvider: async () => provider,
    env: { PHONEPE_ENVIRONMENT: 'SANDBOX', RECONCILER_ENVIRONMENT: 'SANDBOX' },
  });
  const log = mock.method(console, 'log', () => {});
  try {
    await handler({ environment: 'SANDBOX', detail: { environment: 'SANDBOX' } });
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(selects.map((p) => p[0]), ['PRODUCTION']);
  assert.deepEqual(provider.statusCalls, ['ord-prod']);
});

test('production fallback: refuses to run with a SANDBOX secret (no provider call)', async () => {
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');
  provider.environment = 'SANDBOX';
  const handler = createReconcileHandler('PRODUCTION', { getDb: async () => db, resetDb: () => {}, getProvider: async () => provider, env: {} });
  const err = mock.method(console, 'error', () => {});
  try {
    await assert.rejects(() => handler({}), /configured for SANDBOX, not PRODUCTION/);
  } finally {
    err.mock.restore();
  }
  assert.equal(provider.statusCalls.length, 0);
});

test('sandbox fallback: an event payload asking for PRODUCTION is ignored — still SANDBOX only', async () => {
  const { store, db, provider } = setup();
  await openAttemptIn(store, 'ord-sb', 'SANDBOX', 'sim-S1');
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');
  const { spy, selects } = selectSpy(db);
  const handler = createHandler({ getDb: async () => spy, resetDb: () => {}, getProvider: async () => provider, env: { PHONEPE_ENVIRONMENT: 'PRODUCTION' } });
  const log = mock.method(console, 'log', () => {});
  try {
    await handler({ environment: 'PRODUCTION' });
  } finally {
    log.mock.restore();
  }
  assert.deepEqual(selects.map((p) => p[0]), ['SANDBOX']);
  assert.deepEqual(provider.statusCalls, ['ord-sb']);
});

test('production fallback also settles a PRODUCTION attempt left unresolved after the fast window (e.g. a lost message)', async () => {
  const { store, db, provider } = setup();
  provider.environment = 'PRODUCTION';
  await openAttemptIn(store, 'ord-prod', 'PRODUCTION', 'sim-M1');
  const payment = store.payments.find((p) => p.provider_order_id === 'ord-prod')!;
  payment.metadata = { ...(payment.metadata ?? {}), fastReconcileSeq: 7, orderExpiresAt: new Date(T0 - MIN).toISOString() };
  provider.statuses.set('ord-prod', success('TX-LATE'));
  const summary = await reconcilePendingPayments(db, provider, 'PRODUCTION');
  assert.equal(summary.counts.confirmed, 1);
  assert.equal(payment.payment_status, 'paid');
});
