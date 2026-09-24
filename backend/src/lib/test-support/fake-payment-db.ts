// A hand-written in-memory stand-in for the subset of pg.Client the payment/booking-capacity domain
// layer needs (bookings incl. their allocation snapshot columns, simulators, timed
// booking_allocations, and the full `payments` table) — also used for admin status transitions and
// the create-booking-vs-late-payment race, so every one of them shares ONE simulator lock — same rationale and same "light regex on the SQL text, not a real
// parser" approach as test-support/fake-db.ts, and reusing its Mutex primitive for per-row FOR
// UPDATE locking (there, one lock for the whole simulators table; here, one lock per booking row
// and one per payment row, since confirm-successful-payment.ts/start-payment.ts each
// only ever touch one booking and, where relevant, one payment attempt at a time).
//
// Unlike fake-db.ts, this fake also models ROLLBACK: each connection keeps an undo journal of its own
// writes and reverts exactly those (never rows other connections committed meanwhile, as in
// Postgres). confirm-successful-payment.ts's/start-payment.ts's rollback-on-failure tests need
// writes made earlier in a failed transaction to disappear.

import type { DbClient } from '../allocate-simulators';
import type { PaymentProvider, PaymentStatus } from '../payment-repository';
import type { SimulatorRow } from '../simulator-allocation';
import { Mutex } from './fake-db';

export interface FakeBookingRow {
  id: string;
  status: string;
  price_inr: string;
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  /** Owner (JWT sub) and display fields, used only by the customer payment endpoints' lookups. */
  cognito_sub?: string;
  booking_number?: number;
  product_name?: string;
  /** bookings.booking_environment; undefined/null model a NULL row (impossible after migration 007). */
  booking_environment?: 'SANDBOX' | 'PRODUCTION' | null;
}

export interface FakeAllocationRow {
  id: string;
  booking_id: string;
  simulator_id: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
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
  duplicate_of_payment_id?: string | null;
  /** payments.payment_environment; undefined/null model a NULL row (impossible after migration 007). */
  payment_environment?: 'SANDBOX' | 'PRODUCTION' | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export const DEFAULT_FAKE_SIMULATORS: SimulatorRow[] = [
  { id: 'sim-S1', code: 'S1', simulator_type: 'static' },
  { id: 'sim-S2', code: 'S2', simulator_type: 'static' },
  { id: 'sim-M1', code: 'M1', simulator_type: 'motion' },
  { id: 'sim-M2', code: 'M2', simulator_type: 'motion' },
];

export interface FakePaymentDbStore {
  simulators: (SimulatorRow & { is_active: boolean })[];
  simulatorLock: Mutex;
  /** Booking ids whose INSERT is still uncommitted: invisible to other connections' legacy-booking
   *  reads, like an uncommitted row in Postgres. Tests add/remove ids around a simulated create-booking. */
  uncommittedBookingIds: Set<string>;
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

export function createFakePaymentDbStore(simulators: SimulatorRow[] = DEFAULT_FAKE_SIMULATORS): FakePaymentDbStore {
  return {
    simulators: simulators.map((s) => ({ ...s, is_active: true })),
    simulatorLock: new Mutex(),
    uncommittedBookingIds: new Set(),
    bookings: [],
    allocations: [],
    payments: [],
    bookingLocks: new Map(),
    paymentLocks: new Map(),
  };
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
    /** Number of HOLD allocation rows to seed (default 1), on `simulatorIds` (default S1, S2, M1, M2 order). */
    holdAllocations?: number;
    holdExpiresAt?: Date | null;
    simulatorIds?: string[];
    simulatorType?: 'static' | 'motion' | null;
    racers?: number;
    start?: Date;
    end?: Date;
    /** Seed the allocations as 'confirmed' rather than 'hold'. */
    allocationStatus?: 'hold' | 'confirmed';
    cognitoSub?: string;
    bookingNumber?: number;
    productName?: string;
    /** Default 'SANDBOX' (what create-booking.ts writes); pass null to model a NULL row. */
    bookingEnvironment?: 'SANDBOX' | 'PRODUCTION' | null;
  },
): FakeBookingRow {
  const start = input.start ?? new Date(Date.now() + 24 * 60 * 60_000);
  const booking: FakeBookingRow = {
    id: input.id ?? nextId('booking'),
    status: input.status ?? 'pending',
    price_inr: input.priceInr,
    simulator_type: input.simulatorType === undefined ? 'static' : input.simulatorType,
    racers: input.racers ?? 1,
    scheduled_start_at: start,
    scheduled_end_at: input.end ?? new Date(start.getTime() + 30 * 60_000),
    cognito_sub: input.cognitoSub,
    booking_number: input.bookingNumber ?? 1001,
    product_name: input.productName ?? 'Solo Static 30 min',
    booking_environment: input.bookingEnvironment === undefined ? 'SANDBOX' : input.bookingEnvironment,
  };
  store.bookings.push(booking);

  const holdCount = input.holdAllocations ?? 1;
  const ids = input.simulatorIds ?? store.simulators.map((s) => s.id);
  const status = input.allocationStatus ?? 'hold';
  for (let i = 0; i < holdCount; i += 1) {
    store.allocations.push({
      id: nextId('alloc'),
      booking_id: booking.id,
      simulator_id: ids[i % ids.length],
      scheduled_start_at: booking.scheduled_start_at,
      scheduled_end_at: booking.scheduled_end_at,
      allocation_status: status,
      hold_expires_at: status === 'hold' ? (input.holdExpiresAt ?? new Date(Date.now() + 15 * 60_000)) : null,
    });
  }
  return booking;
}

/** Test invariant: no simulator is ever claimed by two overlapping live (hold-unexpired or
 *  confirmed) allocations at the instant `at`. Returns the offending pairs (empty = safe). */
export function findDoubleBookings(store: FakePaymentDbStore, at: Date = new Date()): string[] {
  const live = store.allocations.filter(
    (a) => a.allocation_status === 'confirmed' || (a.allocation_status === 'hold' && a.hold_expires_at !== null && a.hold_expires_at > at),
  );
  const problems: string[] = [];
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const x = live[i];
      const y = live[j];
      if (x.simulator_id === y.simulator_id && x.scheduled_start_at < y.scheduled_end_at && y.scheduled_start_at < x.scheduled_end_at) {
        problems.push(`${x.simulator_id}: ${x.booking_id} vs ${y.booking_id}`);
      }
    }
  }
  return problems;
}

function getOrCreateLock(map: Map<string, Mutex>, key: string): Mutex {
  let mutex = map.get(key);
  if (!mutex) {
    mutex = new Mutex();
    map.set(key, mutex);
  }
  return mutex;
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
export type FakePaymentDbClient = DbClient & {
  /** True between BEGIN and COMMIT/ROLLBACK — lets a test prove provider HTTP never runs inside a transaction. */
  inTransaction(): boolean;
  /** Every FOR UPDATE this connection took, in order: 'payment', 'booking', 'simulators', 'allocations'. */
  lockLog: string[];
};

export function createFakePaymentDbClient(store: FakePaymentDbStore): FakePaymentDbClient {
  let heldLockReleases: (() => void)[] = [];
  let txActive = false;
  let holdsSimulatorLock = false;
  const lockLog: string[] = [];
  // Undo journal: ROLLBACK reverts only what THIS connection wrote (like Postgres), never rows other
  // connections committed in the meantime.
  let journal: (() => void)[] = [];
  const touch = <R extends object>(row: R): void => {
    const before = { ...row };
    journal.push(() => Object.assign(row, before));
  };
  const inserted = <R extends object>(list: R[], row: R): void => {
    list.push(row);
    journal.push(() => {
      const index = list.indexOf(row);
      if (index >= 0) list.splice(index, 1);
    });
  };

  function releaseLocks(): void {
    for (const release of heldLockReleases) {
      release();
    }
    heldLockReleases = [];
    holdsSimulatorLock = false;
  }

  async function query<T extends object>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.trim();

    if (/^BEGIN/i.test(sql)) {
      txActive = true;
      journal = [];
      return { rows: [] };
    }
    if (/^COMMIT/i.test(sql)) {
      txActive = false;
      journal = [];
      releaseLocks();
      return { rows: [] };
    }
    if (/^ROLLBACK/i.test(sql)) {
      txActive = false;
      for (const undo of journal.reverse()) {
        undo();
      }
      journal = [];
      releaseLocks();
      return { rows: [] };
    }

    // findCustomerBooking: ownership is part of the WHERE clause (b.cognito_sub = $2).
    if (/^SELECT b\.id, b\.booking_number, b\.status, p\.name AS product_name/i.test(sql)) {
      const [id, sub] = params as [string, string];
      const row = store.bookings.find((b) => b.id === id && b.cognito_sub === sub);
      return {
        rows: (row
          ? [{ id: row.id, booking_number: row.booking_number, status: row.status, product_name: row.product_name }]
          : []) as unknown as T[],
      };
    }

    // getBookingHoldState
    if (/^SELECT max\(hold_expires_at\)/i.test(sql)) {
      const [bookingId] = params as [string];
      const now = new Date();
      const holds = store.allocations.filter((a) => a.booking_id === bookingId && a.allocation_status === 'hold');
      const times = holds.map((a) => (a.hold_expires_at as Date).getTime());
      return {
        rows: [
          {
            hold_expires_at: holds.length ? new Date(Math.max(...times)) : null,
            hold_expired: holds.length > 0 && holds.every((a) => (a.hold_expires_at as Date) <= now),
          },
        ] as unknown as T[],
      };
    }

    // lockBookingForPayment: SELECT id, status, price_inr FROM bookings WHERE id = $1 FOR UPDATE
    if (/FROM bookings\b/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [id] = params as [string];
      const row = store.bookings.find((b) => b.id === id);
      lockLog.push('booking');
      if (row) {
        heldLockReleases.push(await getOrCreateLock(store.bookingLocks, id).acquire());
      }
      return { rows: (row ? [{ ...row }] : []) as unknown as T[] };
    }

    // findPaymentById: SELECT * FROM payments WHERE id = $1 (no lock)
    if (/^SELECT \* FROM payments WHERE id = \$1$/i.test(sql)) {
      const [id] = params as [string];
      const row = store.payments.find((p) => p.id === id);
      return { rows: (row ? [{ ...row, metadata: row.metadata ? { ...row.metadata } : row.metadata }] : []) as unknown as T[] };
    }

    // advanceFastReconcileSeq: forward-only compare-and-set of metadata.fastReconcileSeq
    // (fromSeq -> fromSeq + 1) on an open attempt.
    if (/^UPDATE payments\b/i.test(sql) && /'fastReconcileSeq'/.test(sql)) {
      const [paymentId, expectedSeq] = params as [string, number];
      const nextSeq = expectedSeq + 1;
      const row = store.payments.find((p) => p.id === paymentId);
      const current = Number((row?.metadata as { fastReconcileSeq?: unknown } | null)?.fastReconcileSeq ?? 0);
      if (row && (row.payment_status === 'created' || row.payment_status === 'pending') && current === expectedSeq) {
        touch(row);
        row.metadata = { ...(row.metadata ?? {}), fastReconcileSeq: nextSeq };
        return { rows: [{ id: row.id }] as unknown as T[] };
      }
      return { rows: [] };
    }

    // lockPaymentById: SELECT * FROM payments WHERE id = $1 FOR UPDATE
    if (/FROM payments\b/i.test(sql) && /WHERE id = \$1 FOR UPDATE/i.test(sql)) {
      const [id] = params as [string];
      const row = store.payments.find((p) => p.id === id);
      lockLog.push('payment');
      if (row) {
        heldLockReleases.push(await getOrCreateLock(store.paymentLocks, row.id).acquire());
      }
      return { rows: (row ? [{ ...row }] : []) as unknown as T[] };
    }

    // lockPaymentByProviderOrderId: SELECT * FROM payments WHERE provider = $1 AND
    // provider_order_id = $2 FOR UPDATE
    if (/FROM payments\b/i.test(sql) && /provider_order_id = \$2/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [provider, providerOrderId] = params as [PaymentProvider, string];
      const row = store.payments.find((p) => p.provider === provider && p.provider_order_id === providerOrderId);
      lockLog.push('payment');
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
    if (/FROM payments\b/i.test(sql) && /payment_status IN \('paid', 'refunded'\)/i.test(sql) && /id <> \$2/i.test(sql)) {
      const [bookingId, excludeId] = params as [string, string];
      const row = store.payments.find(
        (p) =>
          p.booking_id === bookingId &&
          (p.payment_status === 'paid' || p.payment_status === 'refunded') &&
          p.id !== excludeId &&
          !p.duplicate_of_payment_id,
      );
      return { rows: (row ? [{ id: row.id }] : []) as unknown as T[] };
    }

    // listPaymentsForReconciliation: open phonepe attempts with a live checkout, recent, least
    // recently checked first. $1 = environment, $2 = limit. No age cut-off. The environment
    // predicate is taken from the SQL text itself, so the real query's NULL handling is what is
    // exercised: `payment_environment = $1` always, `OR payment_environment IS NULL` only if present.
    if (/FROM payments\b/i.test(sql) && /payment_status IN \('created', 'pending'\)/i.test(sql) && /LIMIT \$2/i.test(sql)) {
      const [environment, limit] = params as [string, number];
      if (!/payment_environment = \$1/i.test(sql)) {
        throw new Error('FakePaymentDbClient: reconciliation query without an environment predicate');
      }
      const nullMatches = /OR payment_environment IS NULL/i.test(sql);
      const envMatches = (p: FakePaymentRow): boolean =>
        p.payment_environment === environment || (nullMatches && (p.payment_environment ?? null) === null);
      const checkedAt = (p: FakePaymentRow): number => {
        const c = p.metadata?.reconcileCheckedAt;
        return typeof c === 'string' ? Date.parse(c) : p.created_at.getTime();
      };
      const rows = store.payments
        .filter(
          (p) =>
            p.provider === 'phonepe' &&
            envMatches(p) &&
            (p.payment_status === 'created' || p.payment_status === 'pending') &&
            typeof (p.metadata?.checkout as { redirectUrl?: unknown } | undefined)?.redirectUrl === 'string',
        )
        .sort((a, b) => checkedAt(a) - checkedAt(b) || a.id.localeCompare(b.id))
        .slice(0, limit)
        .map(({ id, booking_id, provider, provider_order_id, payment_status, payment_environment }) => ({
          id, booking_id, provider, provider_order_id, payment_status, payment_environment: payment_environment ?? null,
        }));
      return { rows: rows as unknown as T[] };
    }

    // lockSimulatorInventory: SELECT ... FROM simulators ... ORDER BY code FOR UPDATE (whole table,
    // one lock, re-entrant within a transaction like Postgres).
    if (/FROM simulators/i.test(sql)) {
      if (/FOR UPDATE/i.test(sql)) {
        lockLog.push('simulators');
        if (!holdsSimulatorLock) {
          heldLockReleases.push(await store.simulatorLock.acquire());
          holdsSimulatorLock = true;
        }
      }
      const rows = store.simulators
        .filter((s) => s.is_active)
        .sort((a, b) => a.code.localeCompare(b.code))
        .map(({ id, code, simulator_type }) => ({ id, code, simulator_type }));
      return { rows: rows as unknown as T[] };
    }

    // lockAllocationsForBooking
    if (/FROM booking_allocations\b/i.test(sql) && /WHERE booking_id = \$1/i.test(sql) && /FOR UPDATE/i.test(sql)) {
      const [bookingId] = params as [string];
      const now = new Date();
      lockLog.push('allocations');
      const rows = store.allocations
        .filter((a) => a.booking_id === bookingId)
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((a) => ({
          id: a.id,
          simulator_id: a.simulator_id,
          allocation_status: a.allocation_status,
          hold_expires_at: a.hold_expires_at,
          hold_expired: a.allocation_status === 'hold' && a.hold_expires_at !== null && a.hold_expires_at <= now,
        }));
      return { rows: rows as unknown as T[] };
    }

    // findAvailableSimulators — legacy-booking demand (checked before the occupancy query because
    // its NOT EXISTS clause also contains "FROM booking_allocations").
    if (/^SELECT .* FROM bookings b\b/is.test(sql)) {
      const [start, end, excludeBookingId] = params as [Date, Date, string];
      const rows = store.bookings.filter(
        (b) =>
          b.id !== excludeBookingId &&
          !store.uncommittedBookingIds.has(b.id) &&
          b.status !== 'cancelled' &&
          b.scheduled_start_at < end &&
          b.scheduled_end_at > start &&
          !store.allocations.some((a) => a.booking_id === b.id),
      );
      return {
        rows: rows.map(({ simulator_type, racers, scheduled_start_at, scheduled_end_at }) => ({
          simulator_type,
          racers,
          scheduled_start_at,
          scheduled_end_at,
        })) as unknown as T[],
      };
    }

    // findAvailableSimulators — occupancy: confirmed, or hold with hold_expires_at > now().
    if (/^SELECT simulator_id, scheduled_start_at/i.test(sql)) {
      const [start, end] = params as [Date, Date];
      const now = new Date();
      const rows = store.allocations.filter(
        (a) =>
          a.scheduled_start_at < end &&
          a.scheduled_end_at > start &&
          (a.allocation_status === 'confirmed' ||
            (a.allocation_status === 'hold' && a.hold_expires_at !== null && a.hold_expires_at > now)),
      );
      return { rows: rows.map((a) => ({ ...a })) as unknown as T[] };
    }

    // insertAllocations (hold or confirmed)
    if (/^INSERT INTO booking_allocations/i.test(sql)) {
      const isConfirmed = /'confirmed'/i.test(sql);
      const [bookingId, simulatorId, start, end, holdExpiresAt] = params as [string, string, Date, Date, Date | undefined];
      inserted(store.allocations, {
        id: nextId('alloc'),
        booking_id: bookingId,
        simulator_id: simulatorId,
        scheduled_start_at: start,
        scheduled_end_at: end,
        allocation_status: isConfirmed ? 'confirmed' : 'hold',
        hold_expires_at: isConfirmed ? null : (holdExpiresAt as Date),
      });
      return { rows: [] };
    }

    // listPaymentsForBooking
    if (/^SELECT \* FROM payments WHERE booking_id = \$1/i.test(sql)) {
      const [bookingId] = params as [string];
      const rows = store.payments.filter((p) => p.booking_id === bookingId);
      return { rows: rows.map((p) => ({ ...p })) as unknown as T[] };
    }

    // mergePaymentMetadata
    if (/^UPDATE payments SET metadata = COALESCE/i.test(sql)) {
      const [paymentId, patch] = params as [string, Record<string, unknown>];
      const row = store.payments.find((p) => p.id === paymentId);
      if (row) {
        touch(row);
        row.metadata = { ...(row.metadata ?? {}), ...patch };
      }
      return { rows: [] };
    }

    // createPaymentAttempt: INSERT INTO payments (...) VALUES (...) RETURNING *
    if (/^INSERT INTO payments/i.test(sql)) {
      const [bookingId, provider, providerOrderId, amountInr, currency, metadata, paymentEnvironment] = params as [
        string,
        PaymentProvider,
        string,
        string,
        string,
        Record<string, unknown> | null,
        'SANDBOX' | 'PRODUCTION' | undefined,
      ];
      // Mirrors the real column: CHECK (IN ('SANDBOX','PRODUCTION')), no DEFAULT — the insert must
      // list the column and bind a value.
      if (!/payment_environment/i.test(sql) || (paymentEnvironment !== 'SANDBOX' && paymentEnvironment !== 'PRODUCTION')) {
        throw new Error('FakePaymentDbClient: payments INSERT without an explicit payment_environment');
      }
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
        payment_environment: paymentEnvironment,
        created_at: now,
        updated_at: now,
        paid_at: null,
      };
      inserted(store.payments, row);
      return { rows: [{ ...row }] as unknown as T[] };
    }

    // markPaymentPaid: UPDATE payments SET payment_status = 'paid', provider_transaction_id =
    // COALESCE($2, provider_transaction_id), paid_at = now() WHERE id = $1
    if (/^UPDATE payments\b/i.test(sql) && /payment_status = 'paid'/i.test(sql)) {
      const [paymentId, providerTransactionId, metadataPatch, duplicateOfPaymentId] = params as [
        string,
        string | null,
        Record<string, unknown> | null,
        string | undefined,
      ];
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
      // Mirrors the narrowed idx_payments_one_paid_per_booking: only PRIMARY paid rows collide.
      const collidesOnPaidBooking =
        !duplicateOfPaymentId &&
        store.payments.some(
          (p) => p.id !== paymentId &&
          p.booking_id === row.booking_id &&
          (p.payment_status === 'paid' || p.payment_status === 'refunded') &&
          !p.duplicate_of_payment_id,
        );
      if (collidesOnPaidBooking) {
        throw pgUniqueViolation('idx_payments_one_paid_per_booking');
      }
      touch(row);
      row.payment_status = 'paid';
      row.metadata = { ...(row.metadata ?? {}), ...(metadataPatch ?? {}) };
      row.provider_transaction_id = newTransactionId;
      if (duplicateOfPaymentId) {
        row.duplicate_of_payment_id = duplicateOfPaymentId;
      }
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
        touch(row);
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
        touch(row);
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
        touch(row);
        row.payment_status = 'pending';
        row.updated_at = new Date();
      }
      return { rows: [] };
    }

    // UPDATE booking_allocations ... (confirm / release / extend hold) — told apart by the SET clause.
    if (/^UPDATE booking_allocations\b/i.test(sql)) {
      if (/SET allocation_status = 'confirmed'/i.test(sql)) {
        const [bookingId] = params as [string];
        for (const alloc of store.allocations) {
          if (alloc.booking_id === bookingId && alloc.allocation_status === 'hold') {
            touch(alloc);
            alloc.allocation_status = 'confirmed';
            alloc.hold_expires_at = null;
          }
        }
        return { rows: [] };
      }
      if (/SET allocation_status = 'released'/i.test(sql)) {
        // releaseHeldAllocations (holds only) and admin cancel (hold + confirmed).
        const [bookingId] = params as [string];
        const includeConfirmed = /IN \('hold', 'confirmed'\)/i.test(sql);
        for (const alloc of store.allocations) {
          if (
            alloc.booking_id === bookingId &&
            (alloc.allocation_status === 'hold' || (includeConfirmed && alloc.allocation_status === 'confirmed'))
          ) {
            touch(alloc);
            alloc.allocation_status = 'released';
            alloc.hold_expires_at = null;
          }
        }
        return { rows: [] };
      }
      if (/SET hold_expires_at = \$2/i.test(sql)) {
        const [bookingId, holdExpiresAt] = params as [string, Date];
        for (const alloc of store.allocations) {
          if (alloc.booking_id === bookingId && alloc.allocation_status === 'hold') {
            touch(alloc);
            alloc.hold_expires_at = holdExpiresAt;
          }
        }
        return { rows: [] };
      }
    }

    // UPDATE bookings: confirmBookingStatus / cancelPendingBooking (pending-guarded, RETURNING id) and
    // the admin generic "SET status = $2 WHERE id = $1".
    if (/^UPDATE bookings\b/i.test(sql)) {
      if (/SET status = \$2/i.test(sql)) {
        const [bookingId, status] = params as [string, string];
        const row = store.bookings.find((b) => b.id === bookingId);
        if (row) {
          touch(row);
          row.status = status;
        }
        return { rows: [] };
      }
      const [bookingId] = params as [string];
      const row = store.bookings.find((b) => b.id === bookingId);
      const target = /SET status = 'cancelled'/i.test(sql) ? 'cancelled' : 'confirmed';
      if (row && row.status === 'pending') {
        touch(row);
        row.status = target;
        return { rows: [{ id: row.id }] as unknown as T[] };
      }
      return { rows: [] };
    }

    throw new Error(`FakePaymentDbClient: unhandled query: ${sql}`);
  }

  return { query, inTransaction: () => txActive, lockLog };
}
