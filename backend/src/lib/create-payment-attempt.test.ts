import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initiatePayment } from './create-payment-attempt';
import { MockPaymentProvider } from './mock-payment-provider';
import { BookingNotFoundError, BookingNotPayableError } from './payment-errors';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking } from './test-support/fake-payment-db';

// "payment record creation/domain model" — exercises the real initiatePayment() (which itself
// calls the real payment-repository.createPaymentAttempt()) against the fake DB, same pattern as
// confirm-successful-payment.test.ts.

test('creates a payment record from the booking\'s own server-side price, never a caller-supplied amount', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '1799.00' });
  const db = createFakePaymentDbClient(store);
  const provider = new MockPaymentProvider();

  const result = await initiatePayment(db, provider, {
    bookingId: booking.id,
    description: 'Grand Race — 15 min',
    generateProviderOrderId: () => 'fixed-order-id',
  });

  assert.equal(result.providerOrderId, 'fixed-order-id');
  assert.equal(result.amountInr, '1799.00');
  assert.equal(result.currency, 'INR');

  assert.equal(store.payments.length, 1);
  const row = store.payments[0];
  assert.equal(row.booking_id, booking.id);
  assert.equal(row.provider, 'mock');
  assert.equal(row.payment_status, 'created');
  assert.equal(row.amount_inr, '1799.00');
  assert.equal(row.paid_at, null);
});

test('rejects a booking that is not "pending" — a new payment attempt cannot be started against it', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '999.00', status: 'confirmed' });
  const db = createFakePaymentDbClient(store);
  const provider = new MockPaymentProvider();

  await assert.rejects(
    () => initiatePayment(db, provider, { bookingId: booking.id, description: 'test' }),
    BookingNotPayableError,
  );
  assert.equal(store.payments.length, 0, 'no payment row should be created for a non-payable booking');
});

test('rejects a booking id that does not exist', async () => {
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);
  const provider = new MockPaymentProvider();

  await assert.rejects(
    () => initiatePayment(db, provider, { bookingId: 'no-such-booking', description: 'test' }),
    BookingNotFoundError,
  );
});
