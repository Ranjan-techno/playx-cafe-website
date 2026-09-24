import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { OrderStatusResponse } from '@phonepe-pg/pg-sdk-node';
import { AmountMismatchError, PaymentProviderError, PaymentProviderOrderNotFoundError } from './payment-errors';
import { createPaymentAttempt } from './payment-repository';
import { PhonePePaymentProvider, type PhonePeCheckoutClient } from './phonepe-payment-provider';
import { reconcilePayment } from './reconcile-payment';
import { createFakePaymentDbClient, createFakePaymentDbStore, findDoubleBookings, seedBooking } from './test-support/fake-payment-db';
import { ScriptedProvider } from './test-support/scripted-provider';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const SLOT = { start: new Date(T0 + 24 * 60 * MIN), end: new Date(T0 + 24 * 60 * MIN + 30 * MIN) };

afterEach(() => mock.timers.reset());

async function setup(holdMinutes = 15) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '999.00', simulatorIds: ['sim-S1'], holdExpiresAt: new Date(T0 + holdMinutes * MIN), ...SLOT });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'phonepe', providerOrderId: 'ord-1', amountInr: '999.00' });
  return { store, booking, db, payment, provider: new ScriptedProvider(db) };
}

test('SUCCESS from the provider flows through applyProviderOutcome -> the safe confirmation path', async () => {
  const { store, db, provider } = await setup();
  provider.statuses.set('ord-1', { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX' });

  const result = await reconcilePayment(db, provider, 'ord-1');

  assert.equal(result.providerOutcome, 'SUCCESS');
  assert.equal(result.applied.status, 'confirmed');
  assert.equal(store.payments[0].payment_status, 'paid');
  assert.equal(store.bookings[0].status, 'confirmed');
  assert.deepEqual(provider.callsInsideTransaction, [false], 'the provider was asked outside any DB transaction');
});

test('PENDING leaves everything untouched; FAILED marks only the payment failed', async () => {
  const pending = await setup();
  pending.provider.statuses.set('ord-1', { outcome: 'PENDING' });
  assert.equal((await reconcilePayment(pending.db, pending.provider, 'ord-1')).applied.status, 'pending');
  assert.equal(pending.store.bookings[0].status, 'pending');
  assert.deepEqual(pending.store.allocations.map((a) => a.allocation_status), ['hold']);

  const failed = await setup();
  failed.provider.statuses.set('ord-1', { outcome: 'FAILED', failureReason: 'PAYMENT_ERROR' });
  assert.equal((await reconcilePayment(failed.db, failed.provider, 'ord-1')).applied.status, 'failed');
  assert.equal(failed.store.payments[0].payment_status, 'failed');
  assert.equal(failed.store.bookings[0].status, 'pending', 'a failed attempt does not cancel the booking');
});

test('duplicate SUCCESS reconciliation is idempotent', async () => {
  const { store, db, provider } = await setup();
  provider.statuses.set('ord-1', { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX' });
  const first = await reconcilePayment(db, provider, 'ord-1');
  const second = await reconcilePayment(db, provider, 'ord-1');
  const third = await reconcilePayment(db, provider, 'ord-1');
  assert.equal(first.applied.status === 'confirmed' && first.applied.alreadyConfirmed, false);
  assert.ok(second.applied.status === 'confirmed' && second.applied.alreadyConfirmed);
  assert.ok(third.applied.status === 'confirmed' && third.applied.alreadyConfirmed);
  assert.equal(store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(store.allocations.filter((a) => a.allocation_status === 'confirmed').length, 1);
});

test('late SUCCESS through reconciliation: expired hold + no capacity -> paid_refund_required, never double-booked', async () => {
  const { store, booking, db, provider } = await setup();
  mock.timers.setTime(T0 + 17 * MIN);
  for (const sim of ['sim-S1', 'sim-S2']) {
    seedBooking(store, { priceInr: '1.00', status: 'confirmed', allocationStatus: 'confirmed', simulatorIds: [sim], ...SLOT });
  }
  provider.statuses.set('ord-1', { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR' });

  const { applied } = await reconcilePayment(db, provider, 'ord-1');

  assert.equal(applied.status, 'paid_refund_required');
  assert.equal(store.payments[0].payment_status, 'paid');
  assert.equal(store.payments[0].metadata?.refundRequired, true);
  assert.equal(store.bookings.find((b) => b.id === booking.id)!.status, 'cancelled');
  assert.deepEqual(findDoubleBookings(store), []);
});

test('late SUCCESS through reconciliation with capacity free: reallocated and confirmed', async () => {
  const { store, db, provider } = await setup();
  mock.timers.setTime(T0 + 17 * MIN);
  provider.statuses.set('ord-1', { outcome: 'SUCCESS', amountInr: '999.00', currency: 'INR' });
  const { applied } = await reconcilePayment(db, provider, 'ord-1');
  assert.ok(applied.status === 'confirmed' && applied.outcome === 'confirmed_after_reallocation');
  assert.equal(store.bookings[0].status, 'confirmed');
});

test('a provider-reported amount that differs from what we charged is rejected and changes nothing', async () => {
  const { store, db, provider } = await setup();
  provider.statuses.set('ord-1', { outcome: 'SUCCESS', amountInr: '1.00', currency: 'INR' });
  await assert.rejects(() => reconcilePayment(db, provider, 'ord-1'), AmountMismatchError);
  assert.equal(store.payments[0].payment_status, 'created');
  assert.equal(store.bookings[0].status, 'pending');
});

test('provider errors propagate untouched and the database is not modified (order not found / 5xx)', async () => {
  const { store, db, provider } = await setup();
  const before = JSON.stringify([store.payments, store.bookings, store.allocations]);
  provider.statuses.set('ord-1', new PaymentProviderOrderNotFoundError());
  await assert.rejects(() => reconcilePayment(db, provider, 'ord-1'), PaymentProviderOrderNotFoundError);
  provider.statuses.set('ord-1', new PaymentProviderError('PhonePe order status failed (HTTP 503)', false, 503));
  await assert.rejects(() => reconcilePayment(db, provider, 'ord-1'), PaymentProviderError);
  assert.equal(JSON.stringify([store.payments, store.bookings, store.allocations]), before);
});

test('end to end with the real PhonePe provider mapping: COMPLETED confirms; PENDING / unknown states never do', async () => {
  const run = async (state: string, amount = 99900) => {
    const { store, db } = await setup();
    const client: Partial<PhonePeCheckoutClient> = {
      getOrderStatus: async () =>
        ({ orderId: 'OM', state, amount, expireAt: 0, paymentDetails: [{ transactionId: 'TXN', state: 'COMPLETED' }] }) as unknown as OrderStatusResponse,
    };
    const provider = new PhonePePaymentProvider(client as PhonePeCheckoutClient, { environment: 'SANDBOX' });
    const result = await reconcilePayment(db, provider, 'ord-1');
    return { store, result };
  };

  const ok = await run('COMPLETED');
  assert.equal(ok.result.applied.status, 'confirmed');
  assert.equal(ok.store.payments[0].provider_transaction_id, 'TXN');

  for (const state of ['PENDING', 'SOMETHING_NEW', '']) {
    const r = await run(state);
    assert.equal(r.result.applied.status, 'pending', state);
    assert.equal(r.store.bookings[0].status, 'pending');
  }
  const failed = await run('FAILED');
  assert.equal(failed.result.applied.status, 'failed');

  await assert.rejects(() => run('COMPLETED', 99901), AmountMismatchError);
});
