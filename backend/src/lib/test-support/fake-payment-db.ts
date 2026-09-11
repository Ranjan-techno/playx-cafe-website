// A hand-written in-memory stand-in for the subset of pg.Client the payment domain layer needs
// (bookings.id/status/price_inr, booking_allocations.allocation_status/hold_expires_at, and the
// full `payments` table) — same rationale and same "light regex on the SQL text, not a real
// parser" approach as test-support/fake-db.ts, and reusing its Mutex primitive for per-row FOR
// UPDATE locking (there, one lock for the whole simulators table; here, one lock per booking row
// and one per payment row, since confirm-successful-payment.ts/create-payment-attempt.ts each
// only ever touch one booking and, where relevant, one payment attempt at a time).
//
// Unlike fake-db.ts, this fake also gives BEGIN a real snapshot/restore: ROLLBACK restores the
// exact pre-BEGIN state of all three tables. fake-db.ts never needed that (allocateSimulators()
// only ever inserts after every check has already passed, so its tests never need to un-insert
// anything), but confirm-successful-payment.ts's rollback-on-failure tests genuinely need writes
// already made earlier in a failed transaction to disappear.

import type { DbClient } from '../allocate-simulators';
import type { PaymentProvider, PaymentStatus } from '../payment-repository';
import { Mutex } from './fake-db';

export interface FakeBookingRow {
  id: string;
  status: string;
  price_inr: string;
}

export interface FakeAllocationRow {
  id: string;
  booking_id: string;
  allocation_status: 'hold' | 'confirmed' | 'released';
  hold_expires_at: Date | null;
}

export interface FakePaymentRow {
  id: string;
  booking_id: string;
  provider: PaymentProvider;
  provider_order_id: string;
  provider_transaction_id: string | null;
  amount_inr: string;
  currency: string;
  payment_status: PaymentStatus;
  failure_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface FakePaymentDbStore {
  bookings: FakeBookingRow[];
  allocations: FakeAllocationRow[];
  payments: FakePaymentRow[];
  bookingLocks: Map<string, Mutex>;
  paymentLocks: Map<string, Mutex>;
}

let idCounter = 0;
/** Monotonic, collision-free across concurrent fake "connections" — JS is single-threaded, so
 *  this increment can never interleave with another call to it (same rationale as fake-db.ts's
 *  own nextId). */
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

export function createFakePaymentDbStore(): FakePaymentDbStore {
  return { bookings: [], allocations: [], payments: [], bookingLocks: new Map(), paymentLocks: new Map() };
}

/** Test setup helper: seeds a booking directly into the store, optionally with HOLD allocation
 *  row(s) — bypassing SQL parsing entirely rather than reverse-engineering create-booking.ts's
 *  exact production INSERT column order here, same spirit as fake-db.ts's FakeLegacyBookingRow
 *  seeding. */
export function seedBooking(
  store: FakePaymentDbStore,
  input: {
    id?: string;
    status?: string;
    priceInr: string;
    holdAllocations?: number;
    holdExpiresAt?: Date | null;
  },
): FakeBookingRow {
  const booking: FakeBookingRow = {
    id: input.id ?? nextId('booking'),
    status: input.status ?? 'pending',
    price_inr: input.priceInr,
  };
  store.bookings.push(booking);

  const holdCount = input.holdAllocations ?? 1;
  for (let i = 0; i < holdCount; i += 1) {
    store.allocations.push({
      id: nextId('alloc'),
      booking_id: booking.id,
      allocation_status: 'hold',
      hold_expires_at: input.holdExpiresAt ?? new Date(Date.now() + 15 * 60_000),
    });
  }
  return booking;
}

function getOrCreateLock(map: Map<string, Mutex>, key: string): Mutex {
  let mutex = map.get(key);
  if (!mutex) {
    mutex = new Mutex();
    map.set(key, mutex);
  }
  return mutex;
}

function clone<T>(rows: T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

/** Throws an Error shaped like a real `pg` unique-violation (SQLSTATE 23505, with `.constraint`
 *  naming the violated index) — matches confirm-successful-payment.ts's isUniqueViolation() check,
 *  so this fake exercises the exact same error-handling path a real Postgres connection would. */
function pgUniqueViolation(constraint: string): Error & { code: string; constraint: string } {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`) as Error & {
    code: string;
    constraint: string;
  };
  err.code = '23505';
  err.constraint = constraint;
  return err;
}

/**
 * One fake "connection" against `store` — call once per concurrent caller, same convention as
 * fake-db.ts's createFakeDbClient.
 */
export function createFakePaymentDbClient(store: FakePaymentDbStore): DbClient {
  let heldLockReleases: (() => void)[] = [];
  let snapshot: { bookings: FakeBookingRow[]; allocations: FakeAllocationRow[]; payments: FakePaymentRow[] } | null = null;

  function releaseLocks(): void {
    for (const release of heldLockReleases) {
      release();
    }
    heldLockReleases = [];
  }

  async function query<T extends object>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();

    if (/^BEGIN/i.test(sql)) {
      snapshot = { bookings: clone(store.bookings), allocations: clone(store.allocations), payments: clone(store.payments) };
      return { rows: [] };
    }
    if (/^COMMIT/i.test(sql)) {
      snapshot = null;
      releaseLocks();
      return { rows: [] };
    }
    if (/^ROLLBACK/i.test(sql)) {
      if (snapshot) {
        store.bookings = snapshot.bookings;
        store.allocations = snapshot.allocations;
        store.payments = snapshot.payments;
        snapshot = null;
      }
      releaseLocks();
      return { rows: [] };
    }

    // lockBookingForPayment: SELECT id, status, price_inr FROM bookings WHERE id = $1 FOR UPDATE
    if (/FROM bookings\b/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [id] = params as [string];
      const row = store.bookings.find((b) => b.id === id);
      if (row) {
        heldLockReleases.push(await getOrCreateLock(store.bookingLocks, id).acquire());
      }
      return { rows: (row ? [{ ...row }] : []) as unknown as T[] };
    }

    // lockPaymentByProviderOrderId: SELECT * FROM payments WHERE provider = $1 AND
    // provider_order_id = $2 FOR UPDATE
    if (/FROM payments\b/i.test(sql) && /provider_order_id = \$2/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [provider, providerOrderId] = params as [PaymentProvider, string];
      const row = store.payments.find((p) => p.provider === provider && p.provider_order_id === providerOrderId);
      if (row) {
        heldLockReleases.push(await getOrCreateLock(store.paymentLocks, row.id).acquire());
      }
      return { rows: (row ? [{ ...row }] : []) as unknown as T[] };
    }

    // sync-payment-status.ts's paymentIdFor: SELECT id FROM payments WHERE provider = $1 AND
    // provider_order_id = $2 (no lock — see that function's own doc comment on why).
    if (/^SELECT id FROM payments WHERE provider = \$1 AND provider_order_id = \$2/i.test(sql)) {
      const [provider, providerOrderId] = params as [PaymentProvider, string];
      const row = store.payments.find((p) => p.provider === provider && p.provider_order_id === providerOrderId);
      return { rows: (row ? [{ id: row.id }] : []) as unknown as T[] };
    }

    // findOtherPaidPaymentForBooking: SELECT id FROM payments WHERE booking_id = $1 AND
    // payment_status = 'paid' AND id <> $2
    if (/FROM payments\b/i.test(sql) && /payment_status = 'paid'/i.test(sql) && /id <> \$2/i.test(sql)) {
      const [bookingId, excludeId] = params as [string, string];
      const row = store.payments.find((p) => p.booking_id === bookingId && p.payment_status === 'paid' && p.id !== excludeId);
      return { rows: (row ? [{ id: row.id }] : []) as unknown as T[] };
    }

    // createPaymentAttempt: INSERT INTO payments (...) VALUES (...) RETURNING *
    if (/^INSERT INTO payments/i.test(sql)) {
      const [bookingId, provider, providerOrderId, amountInr, currency, metadata] = params as [
        string,
        PaymentProvider,
        string,
        string,
        string,
        Record<string, unknown> | null,
      ];
      if (store.payments.some((p) => p.provider === provider && p.provider_order_id === providerOrderId)) {
        throw pgUniqueViolation('idx_payments_provider_order_id_unique');
      }
      const now = new Date();
      const row: FakePaymentRow = {
        id: nextId('payment'),
        booking_id: bookingId,
        provider,
        provider_order_id: providerOrderId,
        provider_transaction_id: null,
        amount_inr: amountInr,
        currency,
        payment_status: 'created',
        failure_reason: null,
        metadata: metadata ?? null,
        created_at: now,
        updated_at: now,
        paid_at: null,
      };
      store.payments.push(row);
      return { rows: [{ ...row }] as unknown as T[] };
    }

    // markPaymentPaid: UPDATE payments SET payment_status = 'paid', provider_transaction_id =
    // COALESCE($2, provider_transaction_id), paid_at = now() WHERE id = $1
    if (/^UPDATE payments\b/i.test(sql) && /payment_status = 'paid'/i.test(sql)) {
      const [paymentId, providerTransactionId] = params as [string, string | null];
      const row = store.payments.find((p) => p.id === paymentId);
      if (!row) {
        return { rows: [] };
      }
      const newTransactionId = providerTransactionId ?? row.provider_transaction_id;
      if (newTransactionId !== null) {
        const collidesOnTransaction = store.payments.some(
          (p) => p.id !== paymentId && p.provider === row.provider && p.provider_transaction_id === newTransactionId,
        );
        if (collidesOnTransaction) {
          throw pgUniqueViolation('idx_payments_provider_transaction_id_unique');
        }
      }
      const collidesOnPaidBooking = store.payments.some(
        (p) => p.id !== paymentId && p.booking_id === row.booking_id && p.payment_status === 'paid',
      );
      if (collidesOnPaidBooking) {
        throw pgUniqueViolation('idx_payments_one_paid_per_booking');
      }
      row.payment_status = 'paid';
      row.provider_transaction_id = newTransactionId;
      row.paid_at = new Date();
      row.updated_at = new Date();
      return { rows: [] };
    }

    // markPaymentFailed: UPDATE payments SET payment_status = 'failed', failure_reason = $2
    // WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')
    if (/^UPDATE payments\b/i.test(sql) && /payment_status = 'failed'/i.test(sql)) {
      const [paymentId, failureReason] = params as [string, string];
      const row = store.payments.find((p) => p.id === paymentId);
      if (row && row.payment_status !== 'paid' && row.payment_status !== 'refunded') {
        row.payment_status = 'failed';
        row.failure_reason = failureReason;
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    // markPaymentExpired: UPDATE payments SET payment_status = 'expired' WHERE id = $1 AND
    // payment_status NOT IN ('paid', 'refunded')
    if (/^UPDATE payments\b/i.test(sql) && /payment_status = 'expired'/i.test(sql)) {
      const [paymentId] = params as [string];
      const row = store.payments.find((p) => p.id === paymentId);
      if (row && row.payment_status !== 'paid' && row.payment_status !== 'refunded') {
        row.payment_status = 'expired';
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    // markPaymentPending: UPDATE payments SET payment_status = 'pending' WHERE id = $1 AND
    // payment_status = 'created'
    if (/^UPDATE payments\b/i.test(sql) && /payment_status = 'pending'/i.test(sql)) {
      const [paymentId] = params as [string];
      const row = store.payments.find((p) => p.id === paymentId);
      if (row && row.payment_status === 'created') {
        row.payment_status = 'pending';
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    // confirmBookingAllocations: UPDATE booking_allocations SET allocation_status = 'confirmed',
    // hold_expires_at = NULL WHERE booking_id = $1 AND allocation_status = 'hold'
    if (/^UPDATE booking_allocations\b/i.test(sql)) {
      const [bookingId] = params as [string];
      for (const alloc of store.allocations) {
        if (alloc.booking_id === bookingId && alloc.allocation_status === 'hold') {
          alloc.allocation_status = 'confirmed';
          alloc.hold_expires_at = null;
        }
      }
      return { rows: [] };
    }

    // confirmBookingStatus: UPDATE bookings SET status = 'confirmed' WHERE id = $1 AND
    // status = 'pending' RETURNING id
    if (/^UPDATE bookings\b/i.test(sql)) {
      const [bookingId] = params as [string];
      const row = store.bookings.find((b) => b.id === bookingId);
      if (row && row.status === 'pending') {
        row.status = 'confirmed';
        return { rows: [{ id: row.id }] as unknown as T[] };
      }
      return { rows: [] };
    }

    throw new Error(`FakePaymentDbClient: unhandled query: ${sql}`);
  }

  return { query };
}
