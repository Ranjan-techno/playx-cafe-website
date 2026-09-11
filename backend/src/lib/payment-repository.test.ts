import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmBookingAllocations,
  confirmBookingStatus,
  createPaymentAttempt,
  findOtherPaidPaymentForBooking,
  lockBookingForPayment,
  lockPaymentByProviderOrderId,
  markPaymentExpired,
  markPaymentFailed,
  markPaymentPaid,
  markPaymentPending,
} from './payment-repository';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking } from './test-support/fake-payment-db';

// "payment record creation/domain model" — direct unit coverage of the repository layer itself,
// independent of the higher-level create-payment-attempt.ts/confirm-successful-payment.ts flows
// that compose these functions (covered in their own test files).

test('createPaymentAttempt inserts a row defaulting to "created" with no paid_at', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);

  const row = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-1', amountInr: '399.00' });

  assert.equal(row.payment_status, 'created');
  assert.equal(row.currency, 'INR');
  assert.equal(row.paid_at, null);
  assert.equal(row.provider_transaction_id, null);
});

test('lockBookingForPayment returns null for a booking that does not exist', async () => {
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);
  assert.equal(await lockBookingForPayment(db, 'missing'), null);
});

test('lockPaymentByProviderOrderId finds a payment by its (provider, provider_order_id) key', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-2', amountInr: '399.00' });

  const found = await lockPaymentByProviderOrderId(db, 'mock', 'order-2');
  assert.ok(found);
  assert.equal(found.booking_id, booking.id);

  assert.equal(await lockPaymentByProviderOrderId(db, 'mock', 'no-such-order'), null);
});

test('markPaymentPaid sets status, paid_at, and provider_transaction_id together', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-3', amountInr: '399.00' });

  await markPaymentPaid(db, payment.id, 'txn-99');

  const row = store.payments.find((p) => p.id === payment.id)!;
  assert.equal(row.payment_status, 'paid');
  assert.equal(row.provider_transaction_id, 'txn-99');
  assert.ok(row.paid_at instanceof Date);
});

test('markPaymentPaid without a transaction id leaves an existing one untouched (COALESCE semantics)', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'order-4', amountInr: '399.00' });
  await markPaymentPaid(db, payment.id, 'first-txn');

  await markPaymentPaid(db, payment.id, null);

  assert.equal(store.payments.find((p) => p.id === payment.id)!.provider_transaction_id, 'first-txn');
});

test('confirmBookingAllocations moves only HOLD rows to CONFIRMED and clears hold_expires_at', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', holdAllocations: 2 });
  store.allocations.push({ id: 'released-1', booking_id: booking.id, allocation_status: 'released', hold_expires_at: null });
  const db = createFakePaymentDbClient(store);

  await confirmBookingAllocations(db, booking.id);

  const rows = store.allocations.filter((a) => a.booking_id === booking.id);
  const holdRows = rows.filter((a) => a.id !== 'released-1');
  for (const row of holdRows) {
    assert.equal(row.allocation_status, 'confirmed');
    assert.equal(row.hold_expires_at, null);
  }
  assert.equal(rows.find((a) => a.id === 'released-1')!.allocation_status, 'released', 'a released row must never be resurrected');
});

test('confirmBookingStatus transitions pending -> confirmed and is idempotent on a second call', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);

  assert.equal(await confirmBookingStatus(db, booking.id), true);
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');

  assert.equal(await confirmBookingStatus(db, booking.id), false, 'a second call is a no-op, not an error');
});

test('findOtherPaidPaymentForBooking excludes the payment itself and non-paid rows', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const paymentA = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'a', amountInr: '399.00' });
  const paymentB = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'b', amountInr: '399.00' });

  assert.equal(await findOtherPaidPaymentForBooking(db, booking.id, paymentA.id), null, 'no paid payment exists yet');

  await markPaymentPaid(db, paymentB.id, null);

  const found = await findOtherPaidPaymentForBooking(db, booking.id, paymentA.id);
  assert.equal(found?.id, paymentB.id);
  assert.equal(await findOtherPaidPaymentForBooking(db, booking.id, paymentB.id), null, 'excludes itself');
});

test('markPaymentFailed/markPaymentExpired never override an already-paid payment', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'c', amountInr: '399.00' });
  await markPaymentPaid(db, payment.id, null);

  await markPaymentFailed(db, payment.id, 'late failure report');
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid');

  await markPaymentExpired(db, payment.id);
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid');
});

test('markPaymentPending only ever moves a "created" attempt to "pending"', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: 'd', amountInr: '399.00' });

  await markPaymentPending(db, payment.id);
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'pending');

  await markPaymentPaid(db, payment.id, null);
  await markPaymentPending(db, payment.id);
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid', 'a paid payment must never revert to pending');
});
