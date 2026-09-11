import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmSuccessfulPayment } from './confirm-successful-payment';
import {
  AmountMismatchError,
  BookingAlreadyPaidError,
  BookingNotConfirmableError,
  CurrencyMismatchError,
  DuplicateProviderTransactionError,
  PaymentAlreadyFinalizedError,
  PaymentNotFoundError,
} from './payment-errors';
import { createPaymentAttempt } from './payment-repository';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  seedBooking,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';
import type { DbClient } from './allocate-simulators';

// Exercises the *real* confirmSuccessfulPayment() (not a reimplementation) against the fake
// in-memory DB in test-support/fake-payment-db.ts, same rationale as
// allocate-simulators.test.ts/test-support/fake-db.ts: no real Postgres is available in this repo.

async function seedPaidPendingBooking(
  store: FakePaymentDbStore,
  overrides: { priceInr?: string; providerOrderId?: string; holdAllocations?: number } = {},
) {
  const booking = seedBooking(store, { priceInr: overrides.priceInr ?? '999.00', holdAllocations: overrides.holdAllocations ?? 1 });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, {
    bookingId: booking.id,
    provider: 'mock',
    providerOrderId: overrides.providerOrderId ?? `order-${booking.id}`,
    amountInr: booking.price_inr,
  });
  return { booking, payment, db };
}

test('successful confirmation: payment becomes PAID, allocations move HOLD -> CONFIRMED, hold_expires_at cleared, booking confirmed', async () => {
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await seedPaidPendingBooking(store, { holdAllocations: 2 });

  const result = await confirmSuccessfulPayment(db, {
    provider: 'mock',
    providerOrderId: payment.provider_order_id,
    amountInr: 999.0,
    providerTransactionId: 'txn-1',
  });

  assert.equal(result.alreadyConfirmed, false);
  assert.equal(result.paymentId, payment.id);
  assert.equal(result.bookingId, booking.id);

  const storedPayment = store.payments.find((p) => p.id === payment.id)!;
  assert.equal(storedPayment.payment_status, 'paid');
  assert.equal(storedPayment.provider_transaction_id, 'txn-1');
  assert.ok(storedPayment.paid_at instanceof Date);

  const storedBooking = store.bookings.find((b) => b.id === booking.id)!;
  assert.equal(storedBooking.status, 'confirmed');

  const allocations = store.allocations.filter((a) => a.booking_id === booking.id);
  assert.equal(allocations.length, 2);
  for (const alloc of allocations) {
    assert.equal(alloc.allocation_status, 'confirmed');
    assert.equal(alloc.hold_expires_at, null);
  }
});

test('confirmed simulator remains blocked: a CONFIRMED allocation has no expiry, unlike the original HOLD', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);

  await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0 });

  const alloc = store.allocations.find((a) => a.booking_id === booking.id)!;
  assert.equal(alloc.allocation_status, 'confirmed');
  assert.equal(alloc.hold_expires_at, null, 'a confirmed allocation must not carry a hold_expires_at that could let it lapse');
});

test('idempotency: three identical successful callbacks for the same attempt result in exactly one PAID payment and one confirmation', async () => {
  const store = createFakePaymentDbStore();
  const { payment, db } = await seedPaidPendingBooking(store);

  const results = [];
  for (let i = 0; i < 3; i += 1) {
    results.push(
      await confirmSuccessfulPayment(db, {
        provider: 'mock',
        providerOrderId: payment.provider_order_id,
        amountInr: 999.0,
        providerTransactionId: 'txn-dup',
      }),
    );
  }

  assert.equal(results[0].alreadyConfirmed, false, 'the first call performs the real confirmation');
  assert.equal(results[1].alreadyConfirmed, true, 'the second call recognizes the payment is already paid');
  assert.equal(results[2].alreadyConfirmed, true, 'the third call recognizes the payment is already paid');

  assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(store.payments.length, 1, 'no duplicate payment row was ever created');
});

test('duplicate provider transaction is protected: a different payment attempt cannot reuse an already-recorded provider transaction id', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '500.00' });
  const db = createFakePaymentDbClient(store);

  const paymentA = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-a', amountInr: '500.00' });
  await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: paymentA.provider_order_id, amountInr: 500.0, providerTransactionId: 'shared-txn' });

  // A second, unrelated booking + payment attempt somehow reports the exact same provider
  // transaction id (e.g. a provider bug, or a spoofed callback).
  const bookingB = seedBooking(store, { priceInr: '500.00' });
  const paymentB = await createPaymentAttempt(db, { bookingId: bookingB.id, provider: 'mock', providerOrderId: 'order-b', amountInr: '500.00' });

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: paymentB.provider_order_id, amountInr: 500.0, providerTransactionId: 'shared-txn' }),
    DuplicateProviderTransactionError,
  );

  const storedB = store.payments.find((p) => p.id === paymentB.id)!;
  assert.notEqual(storedB.payment_status, 'paid', 'the second payment must not have been marked paid');
  assert.equal(store.bookings.find((b) => b.id === bookingB.id)!.status, 'pending', 'the second booking must not have been confirmed');
});

test('one successful payment per booking: a second payment attempt on an already-paid booking is rejected, not confirmed again', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '750.00', holdAllocations: 1 });
  const db = createFakePaymentDbClient(store);

  const paymentA = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-a', amountInr: '750.00' });
  await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: paymentA.provider_order_id, amountInr: 750.0 });

  // A second attempt against the same (already-confirmed) booking — e.g. the customer double-paid,
  // or a stale client retried checkout after the first attempt had already gone through.
  const paymentB = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-b', amountInr: '750.00' });

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: paymentB.provider_order_id, amountInr: 750.0 }),
    BookingAlreadyPaidError,
  );

  assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 1, 'only the first attempt is ever paid');
});

test('incorrect amount rejected: a provider-reported amount that does not match the payment record is rejected', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store, { priceInr: '999.00' });

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 1.0 }),
    AmountMismatchError,
  );

  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'created');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
});

test('incorrect currency rejected: a provider-reported currency other than the payment record\'s is rejected', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0, currency: 'USD' }),
    CurrencyMismatchError,
  );

  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'created');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
});

test('failed payment does not confirm booking: confirming an attempt already marked failed is rejected', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);
  const stored = store.payments.find((p) => p.id === payment.id)!;
  stored.payment_status = 'failed';
  stored.failure_reason = 'Insufficient funds';

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0 }),
    PaymentAlreadyFinalizedError,
  );

  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
  assert.equal(store.allocations.find((a) => a.booking_id === booking.id)!.allocation_status, 'hold');
});

test('expired payment does not confirm booking: confirming an attempt already marked expired is rejected', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);
  store.payments.find((p) => p.id === payment.id)!.payment_status = 'expired';

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0 }),
    PaymentAlreadyFinalizedError,
  );

  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
});

test('pending payment: an attempt still in "pending" can still be confirmed successful (pending is not terminal)', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);
  store.payments.find((p) => p.id === payment.id)!.payment_status = 'pending';

  const result = await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0 });

  assert.equal(result.alreadyConfirmed, false);
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
});

test('failed attempt followed by successful attempt: booking is confirmed only by the verified successful one', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '1099.00', holdAllocations: 1 });
  const db = createFakePaymentDbClient(store);

  const attemptA = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'attempt-a', amountInr: '1099.00' });
  // Attempt A's provider callback reported failure — simulated directly (markPaymentFailed's own
  // behavior is covered by payment-repository.test.ts and sync-payment-status.test.ts).
  store.payments.find((p) => p.id === attemptA.id)!.payment_status = 'failed';

  const attemptB = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'attempt-b', amountInr: '1099.00' });
  const result = await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: attemptB.provider_order_id, amountInr: 1099.0 });

  assert.equal(result.paymentId, attemptB.id);
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
  assert.equal(store.payments.find((p) => p.id === attemptA.id)!.payment_status, 'failed');
  assert.equal(store.payments.find((p) => p.id === attemptB.id)!.payment_status, 'paid');
});

test('unknown payment: confirming a provider order id with no matching payment row is rejected', async () => {
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: 'no-such-order', amountInr: 100 }),
    PaymentNotFoundError,
  );
});

test('booking no longer confirmable: a successful payment against a cancelled booking is rejected, not silently confirmed', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', status: 'cancelled', holdAllocations: 0 });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-cancelled', amountInr: '399.00' });

  await assert.rejects(
    () => confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 399.0 }),
    BookingNotConfirmableError,
  );

  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'created');
});

test('database transaction rolls back on failure: a mid-transaction error undoes every write already made in that attempt', async () => {
  const store = createFakePaymentDbStore();
  const { payment, booking, db } = await seedPaidPendingBooking(store);

  // Wraps the real fake client so the *last* write in the happy path (confirming booking.status)
  // throws — simulating a hard DB error after the payment-paid and allocation-confirmed writes
  // have already been issued earlier in the same transaction.
  const flakyDb: DbClient = {
    query: async (text, params) => {
      if (/^UPDATE bookings\b/i.test(text.trim())) {
        throw new Error('simulated connection loss');
      }
      return db.query(text, params);
    },
  };

  await assert.rejects(() =>
    confirmSuccessfulPayment(flakyDb, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: 999.0 }),
  );

  // Despite the payment-paid and allocation-confirmed writes having already run before the forced
  // failure, ROLLBACK must have undone all of them — nothing is left half-migrated.
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'created', 'payment write must have been rolled back');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending', 'booking must remain pending');
  assert.equal(
    store.allocations.find((a) => a.booking_id === booking.id)!.allocation_status,
    'hold',
    'allocation write must have been rolled back',
  );
});
