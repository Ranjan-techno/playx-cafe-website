import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyProviderOutcome } from './sync-payment-status';
import { createPaymentAttempt } from './payment-repository';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking } from './test-support/fake-payment-db';

// Exercises the dispatcher between a provider outcome and the correct payment-state transition —
// see sync-payment-status.ts's header on why FAILED/PENDING/expired must never reach
// confirmSuccessfulPayment().

async function seedAttempt(store: ReturnType<typeof createFakePaymentDbStore>) {
  const booking = seedBooking(store, { priceInr: '599.00', holdAllocations: 1 });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { bookingId: booking.id, provider: 'mock', providerOrderId: `order-${booking.id}`, amountInr: '599.00' });
  return { booking, payment, db };
}

test('SUCCESS outcome confirms the booking (delegates to confirmSuccessfulPayment)', async () => {
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await seedAttempt(store);

  const result = await applyProviderOutcome(db, {
    provider: 'mock',
    providerOrderId: payment.provider_order_id,
    outcome: 'SUCCESS',
    amountInr: 599.0,
    providerTransactionId: 'txn-success',
  });

  assert.equal(result.status, 'confirmed');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'confirmed');
});

test('pending payment does not confirm booking: a PENDING outcome leaves the booking and its allocations untouched', async () => {
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await seedAttempt(store);

  const result = await applyProviderOutcome(db, { provider: 'mock', providerOrderId: payment.provider_order_id, outcome: 'PENDING' });

  assert.equal(result.status, 'pending');
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'pending');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending', 'a pending payment must never confirm the booking');
  assert.equal(store.allocations.find((a) => a.booking_id === booking.id)!.allocation_status, 'hold');
});

test('failed payment does not confirm booking: a FAILED outcome marks the payment failed without touching the booking', async () => {
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await seedAttempt(store);

  const result = await applyProviderOutcome(db, {
    provider: 'mock',
    providerOrderId: payment.provider_order_id,
    outcome: 'FAILED',
    failureReason: 'Card declined',
  });

  assert.equal(result.status, 'failed');
  const storedPayment = store.payments.find((p) => p.id === payment.id)!;
  assert.equal(storedPayment.payment_status, 'failed');
  assert.equal(storedPayment.failure_reason, 'Card declined');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending', 'a failed attempt must not corrupt the booking');
  assert.equal(store.allocations.find((a) => a.booking_id === booking.id)!.allocation_status, 'hold', 'the HOLD survives a failed attempt so a retry can still use it');
});

test('expired payment does not confirm booking: the expired flag marks the payment expired without touching the booking', async () => {
  const store = createFakePaymentDbStore();
  const { booking, payment, db } = await seedAttempt(store);

  const result = await applyProviderOutcome(db, { provider: 'mock', providerOrderId: payment.provider_order_id, outcome: 'PENDING', expired: true });

  assert.equal(result.status, 'expired');
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'expired');
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'pending');
});

test('a SUCCESS outcome without an amount is rejected before ever touching the database', async () => {
  const store = createFakePaymentDbStore();
  const { payment, db } = await seedAttempt(store);

  await assert.rejects(() => applyProviderOutcome(db, { provider: 'mock', providerOrderId: payment.provider_order_id, outcome: 'SUCCESS' }));
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'created');
});
