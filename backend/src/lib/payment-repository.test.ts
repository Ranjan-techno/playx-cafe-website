import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  confirmBookingAllocations,
  confirmBookingStatus,
  createPaymentAttempt,
  findOtherPaidPaymentForBooking,
  listPaymentsForReconciliation,
  lockBookingForPayment,
  lockPaymentByProviderOrderId,
  markPaymentExpired,
  markPaymentFailed,
  markPaymentPaid,
  markPaymentPending,
} from './payment-repository';
import type { DbClient } from './allocate-simulators';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking, type FakePaymentDbStore } from './test-support/fake-payment-db';

// "payment record creation/domain model" — direct unit coverage of the repository layer itself,
// independent of the higher-level start-payment.ts/confirm-successful-payment.ts flows
// that compose these functions (covered in their own test files).

test('createPaymentAttempt inserts a row defaulting to "created" with no paid_at', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);

  const row = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'order-1', amountInr: '399.00' });

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
  await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'order-2', amountInr: '399.00' });

  const found = await lockPaymentByProviderOrderId(db, 'mock', 'order-2');
  assert.ok(found);
  assert.equal(found.booking_id, booking.id);

  assert.equal(await lockPaymentByProviderOrderId(db, 'mock', 'no-such-order'), null);
});

test('markPaymentPaid sets status, paid_at, and provider_transaction_id together', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'order-3', amountInr: '399.00' });

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
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'order-4', amountInr: '399.00' });
  await markPaymentPaid(db, payment.id, 'first-txn');

  await markPaymentPaid(db, payment.id, null);

  assert.equal(store.payments.find((p) => p.id === payment.id)!.provider_transaction_id, 'first-txn');
});

test('confirmBookingAllocations moves only HOLD rows to CONFIRMED and clears hold_expires_at', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', holdAllocations: 2 });
  store.allocations.push({
    id: 'released-1',
    booking_id: booking.id,
    simulator_id: 'sim-S1',
    scheduled_start_at: booking.scheduled_start_at,
    scheduled_end_at: booking.scheduled_end_at,
    allocation_status: 'released',
    hold_expires_at: null,
  });
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
  const paymentA = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'a', amountInr: '399.00' });
  const paymentB = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'b', amountInr: '399.00' });

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
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'c', amountInr: '399.00' });
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
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'd', amountInr: '399.00' });

  await markPaymentPending(db, payment.id);
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'pending');

  await markPaymentPaid(db, payment.id, null);
  await markPaymentPending(db, payment.id);
  assert.equal(store.payments.find((p) => p.id === payment.id)!.payment_status, 'paid', 'a paid payment must never revert to pending');
});

test('findOtherPaidPaymentForBooking: the duplicate_of_payment_id column, not the metadata mirror, decides who is primary', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const primary = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'p', amountInr: '399.00' });
  const dup = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'd', amountInr: '399.00' });
  const probe = await createPaymentAttempt(db, { paymentEnvironment: 'SANDBOX', bookingId: booking.id, provider: 'mock', providerOrderId: 'x', amountInr: '399.00' });
  await markPaymentPaid(db, primary.id, null);
  await markPaymentPaid(db, dup.id, null, null, primary.id);

  assert.equal((await findOtherPaidPaymentForBooking(db, booking.id, probe.id))?.id, primary.id, 'duplicate row is never the primary');

  // Metadata alone (no column) does not make a row a duplicate.
  const row = store.payments.find((p) => p.id === dup.id)!;
  row.duplicate_of_payment_id = null;
  row.metadata = { ...(row.metadata ?? {}), duplicateOfPaymentId: primary.id };
  const found = await findOtherPaidPaymentForBooking(db, booking.id, probe.id);
  assert.ok(found, 'a paid row with a NULL column is a primary candidate regardless of metadata');
});

// ----------------------------------------------------------------------------
// payment_environment (typed column, migration 006)
// ----------------------------------------------------------------------------

/** Wraps a DbClient, recording every statement. */
function recording(db: DbClient): DbClient & { log: { text: string; params: unknown[] }[] } {
  const log: { text: string; params: unknown[] }[] = [];
  return {
    log,
    query: async (text: string, params: unknown[] = []) => {
      log.push({ text, params });
      return db.query(text, params);
    },
  } as DbClient & { log: { text: string; params: unknown[] }[] };
}

test('createPaymentAttempt writes payment_environment explicitly and mirrors it into metadata', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = recording(createFakePaymentDbClient(store));

  const row = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: 'env-1',
    amountInr: '399.00',
    metadata: { environment: 'SANDBOX', holdExtended: true },
  });

  assert.equal(row.payment_environment, 'SANDBOX');
  assert.deepEqual(row.metadata, { environment: 'SANDBOX', holdExtended: true, paymentEnvironment: 'SANDBOX' });
  const insert = db.log.find((q) => /^\s*INSERT INTO payments/i.test(q.text))!;
  assert.match(insert.text, /payment_environment\)/);
  assert.equal(insert.params[6], 'SANDBOX');
});

test('createPaymentAttempt: stale metadata can never disagree with the typed column', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = createFakePaymentDbClient(store);
  const row = await createPaymentAttempt(db, {
    paymentEnvironment: 'SANDBOX',
    bookingId: booking.id,
    provider: 'phonepe',
    providerOrderId: 'env-2',
    amountInr: '399.00',
    metadata: { paymentEnvironment: 'PRODUCTION' },
  });
  assert.equal(row.payment_environment, 'SANDBOX');
  assert.equal(row.metadata?.paymentEnvironment, 'SANDBOX');
});

test('createPaymentAttempt: a missing or unknown environment throws before any SQL (no silent row)', async () => {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00' });
  const db = recording(createFakePaymentDbClient(store));
  for (const paymentEnvironment of [undefined, null, '', 'sandbox', 'LIVE']) {
    await assert.rejects(
      () =>
        createPaymentAttempt(db, {
          bookingId: booking.id,
          provider: 'phonepe',
          providerOrderId: `bad-${String(paymentEnvironment)}`,
          amountInr: '399.00',
          paymentEnvironment,
        } as never),
      /paymentEnvironment must be SANDBOX or PRODUCTION/,
    );
  }
  assert.equal(db.log.length, 0);
  assert.equal(store.payments.length, 0);
});

test('lockBookingForPayment returns the typed booking_environment', async () => {
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);
  const sandbox = seedBooking(store, { priceInr: '1.00' });
  const legacy = seedBooking(store, { priceInr: '1.00', bookingEnvironment: null });
  assert.equal((await lockBookingForPayment(db, sandbox.id))?.booking_environment, 'SANDBOX');
  await db.query('COMMIT');
  assert.equal((await lockBookingForPayment(db, legacy.id))?.booking_environment, null);
  await db.query('COMMIT');
});

/** Three open PhonePe attempts with a live checkout: SANDBOX, NULL (impossible after 007), PRODUCTION. */
async function seedEnvironmentAttempts(): Promise<{ store: FakePaymentDbStore; db: DbClient }> {
  const store = createFakePaymentDbStore();
  const db = createFakePaymentDbClient(store);
  for (const env of ['SANDBOX', 'NULL', 'PRODUCTION'] as const) {
    const booking = seedBooking(store, { priceInr: '1.00' });
    const row = await createPaymentAttempt(db, {
      paymentEnvironment: env === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
      bookingId: booking.id,
      provider: 'phonepe',
      providerOrderId: `ord-${env}`,
      amountInr: '1.00',
      metadata: { checkout: { redirectUrl: 'https://pay.test/x' } },
    });
    if (env === 'NULL') {
      store.payments.find((p) => p.id === row.id)!.payment_environment = null;
    }
  }
  return { store, db };
}

test('listPaymentsForReconciliation(SANDBOX) selects only SANDBOX, never NULL or PRODUCTION', async () => {
  const { db } = await seedEnvironmentAttempts();
  const rows = await listPaymentsForReconciliation(db, 'SANDBOX', 25);
  assert.deepEqual(rows.map((r) => r.provider_order_id), ['ord-SANDBOX']);
});

test('listPaymentsForReconciliation(PRODUCTION) selects only PRODUCTION, never NULL', async () => {
  const { db } = await seedEnvironmentAttempts();
  const rows = await listPaymentsForReconciliation(db, 'PRODUCTION', 25);
  assert.deepEqual(rows.map((r) => r.provider_order_id), ['ord-PRODUCTION']);
});

test('listPaymentsForReconciliation SQL: both environments are a strict `= $1` match with no NULL branch; environment is bound, not interpolated', async () => {
  const seen: { text: string; params: unknown[] }[] = [];
  const db: DbClient = { query: async (text: string, params: unknown[] = []) => { seen.push({ text, params }); return { rows: [] }; } } as DbClient;
  await listPaymentsForReconciliation(db, 'SANDBOX', 5);
  await listPaymentsForReconciliation(db, 'PRODUCTION', 5);
  assert.match(seen[0].text, /AND payment_environment = \$1\s/);
  assert.doesNotMatch(seen[0].text, /payment_environment IS NULL/);
  assert.deepEqual(seen[0].params, ['SANDBOX', 5]);
  assert.match(seen[1].text, /AND payment_environment = \$1\s/);
  assert.doesNotMatch(seen[1].text, /payment_environment IS NULL/);
  assert.deepEqual(seen[1].params, ['PRODUCTION', 5]);
  for (const q of seen) assert.doesNotMatch(q.text, /'(SANDBOX|PRODUCTION)'/);
});

test('listPaymentsForReconciliation: environment is required (missing/unknown throws, no query)', async () => {
  let queried = false;
  const db: DbClient = { query: async () => { queried = true; return { rows: [] }; } } as DbClient;
  for (const env of [undefined, null, 'sandbox', 25]) {
    await assert.rejects(() => listPaymentsForReconciliation(db, env as never, 25), /environment must be SANDBOX or PRODUCTION/);
  }
  assert.equal(queried, false);
});
