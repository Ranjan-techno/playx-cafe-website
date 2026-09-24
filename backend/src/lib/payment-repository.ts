// Phase 3A: the DB-touching half of the payment domain layer — thin CRUD/lookup helpers against
// `payments` (and the couple of `bookings` columns confirm-successful-payment.ts needs), matching
// the split allocate-simulators.ts/simulator-allocation.ts already established: this file only
// issues SQL, with no allocation/confirmation policy of its own — that lives in
// start-payment.ts and confirm-successful-payment.ts, which call these.
//
// Reuses allocate-simulators.ts's DbClient — the same minimal `query(text, params)` surface
// db.ts's getDb() already satisfies, and the same shape lib/test-support/fake-*.ts fakes
// implement for tests. Defined once there rather than a second time here.

import type { DbClient } from './allocate-simulators';
import { assertAppEnvironment, environmentMatchSql, type AppEnvironment } from './environment';

export type PaymentProvider = 'phonepe' | 'mock';
export type PaymentStatus = 'created' | 'pending' | 'paid' | 'failed' | 'expired' | 'refunded';

/** Terminal states a payment attempt never leaves once reached — see 003_payment_foundation.sql's
 *  payment_status enum comment. Exported so confirm-successful-payment.ts/sync-payment-status.ts
 *  share one definition instead of repeating the literal list. */
export const TERMINAL_NON_PAID_STATUSES: readonly PaymentStatus[] = ['failed', 'expired', 'refunded'];

export interface PaymentRow {
  id: string;
  booking_id: string;
  provider: PaymentProvider;
  provider_order_id: string;
  provider_transaction_id: string | null;
  amount_inr: string; // pg returns NUMERIC as a string, same convention as bookings.price_inr
  currency: string;
  payment_status: PaymentStatus;
  failure_reason: string | null;
  metadata: Record<string, unknown> | null;
  /** Typed SANDBOX/PRODUCTION marker (migration 006) — the source of truth; metadata.paymentEnvironment
   *  is only a mirror. NULL only on a transitional row written before this code was deployed (see
   *  environment.ts). */
  payment_environment: AppEnvironment | null;
  /** Set only on a 'paid' row that duplicates an earlier paid payment for the same booking (see
   *  005_duplicate_payment_recording.sql). NULL/undefined for every primary payment. */
  duplicate_of_payment_id?: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface BookingForPaymentRow {
  id: string;
  status: string;
  price_inr: string;
  /** The booking's own snapshot columns — what secureBookingCapacity() derives the simulator
   *  requirement and window from (never the current product row). */
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  /** Typed environment (migration 006); NULL only on a transitional row — see environment.ts. */
  booking_environment: AppEnvironment | null;
}

export interface AllocationLockRow {
  id: string;
  simulator_id: string;
  allocation_status: 'hold' | 'confirmed' | 'released';
  hold_expires_at: Date | null;
  /** Computed by the DATABASE clock (`now()`), the same clock the availability queries use, so
   *  "expired" means the same thing everywhere. */
  hold_expired: boolean;
}

export interface CreatePaymentAttemptInput {
  bookingId: string;
  provider: PaymentProvider;
  providerOrderId: string;
  amountInr: string;
  currency?: string;
  /** Required, from the validated backend PhonePe config — never from client input. Written to the
   *  typed payments.payment_environment column and mirrored into metadata.paymentEnvironment. */
  paymentEnvironment: AppEnvironment;
  metadata?: Record<string, unknown> | null;
}

/** Inserts a new 'created' payment attempt row. Never sets payment_status to anything but the
 *  column default ('created') — a caller advances it later via markPaymentPending/
 *  confirmSuccessfulPayment/markPaymentFailed/markPaymentExpired, each a deliberate, auditable
 *  transition rather than this function guessing an initial state.
 *
 *  payment_environment is always written explicitly (the column has no DEFAULT); a missing or
 *  unknown environment throws before any SQL runs. metadata.paymentEnvironment is overwritten with
 *  the same value so the compatibility mirror can never disagree with the typed column. */
export async function createPaymentAttempt(db: DbClient, input: CreatePaymentAttemptInput): Promise<PaymentRow> {
  const paymentEnvironment = assertAppEnvironment(input.paymentEnvironment, 'paymentEnvironment');
  const metadata = { ...(input.metadata ?? {}), paymentEnvironment };
  const { rows } = await db.query<PaymentRow>(
    `INSERT INTO payments (booking_id, provider, provider_order_id, amount_inr, currency, metadata, payment_environment)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [input.bookingId, input.provider, input.providerOrderId, input.amountInr, input.currency ?? 'INR', metadata, paymentEnvironment],
  );
  return rows[0];
}

/** Locks a booking row (id, status, price_inr + its allocation snapshot columns) FOR UPDATE — the "server-controlled expected
 *  amount" both start-payment.ts and confirm-successful-payment.ts check against is
 *  always read from here, never from the browser. Returns null if the booking doesn't exist
 *  (defensive only — payments.booking_id is a NOT NULL FK, so this should be unreachable once a
 *  payment row exists). */
export async function lockBookingForPayment(db: DbClient, bookingId: string): Promise<BookingForPaymentRow | null> {
  const { rows } = await db.query<BookingForPaymentRow>(
    `SELECT id, status, price_inr, simulator_type, racers, scheduled_start_at, scheduled_end_at, booking_environment
     FROM bookings WHERE id = $1 FOR UPDATE`,
    [bookingId],
  );
  return rows[0] ?? null;
}

/** Locks a payment row FOR UPDATE by its natural external key — (provider, provider_order_id) is
 *  exactly what a provider webhook/callback carries back (see payment-provider.ts's
 *  WebhookVerificationResult), never payments.id itself, which the provider never sees. */
export async function lockPaymentByProviderOrderId(
  db: DbClient,
  provider: PaymentProvider,
  providerOrderId: string,
): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE provider = $1 AND provider_order_id = $2 FOR UPDATE`,
    [provider, providerOrderId],
  );
  return rows[0] ?? null;
}

/** Any *other* primary 'paid' or 'refunded' payment already recorded for this booking (rows flagged as duplicates
 *  via the duplicate_of_payment_id column — see markPaymentPaid and migration 005 — don't count; the column,
 *  not the metadata audit mirror, is the source of truth) — the application-level mirror of
 *  the idx_payments_one_paid_per_booking (a refunded primary stays the primary — refunding it must
 *  not let a later collection become a second primary) partial unique index, checked before attempting the
 *  UPDATE below so a real double-payment produces a clear BookingAlreadyPaidError instead of a raw
 *  constraint-violation. `excludePaymentId` is the attempt currently being confirmed, so it never
 *  matches itself. */
export async function findOtherPaidPaymentForBooking(
  db: DbClient,
  bookingId: string,
  excludePaymentId: string,
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM payments
     WHERE booking_id = $1 AND payment_status IN ('paid', 'refunded') AND id <> $2
       AND duplicate_of_payment_id IS NULL`,
    [bookingId, excludePaymentId],
  );
  return rows[0] ?? null;
}

/** The one writer of payment_status = 'paid'. `duplicateOfPaymentId` is set only when this payment
 *  is a second collected payment for a booking another payment already confirmed. Only called after every validation in
 *  confirm-successful-payment.ts has already passed — this function itself has no policy, it just
 *  performs the write (and lets a unique-constraint violation on provider_transaction_id surface
 *  to the caller, which translates it into DuplicateProviderTransactionError). */
export async function markPaymentPaid(
  db: DbClient,
  paymentId: string,
  providerTransactionId: string | null,
  metadataPatch: Record<string, unknown> | null = null,
  duplicateOfPaymentId: string | null = null,
): Promise<void> {
  // duplicate_of_payment_id is only mentioned when set, so ordinary confirmations keep working
  // against a database that hasn't had migration 005 applied yet.
  const duplicateClause = duplicateOfPaymentId ? ', duplicate_of_payment_id = $4' : '';
  await db.query(
    `UPDATE payments
     SET payment_status = 'paid',
         provider_transaction_id = COALESCE($2, provider_transaction_id),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE($3::jsonb, '{}'::jsonb),
         paid_at = now()${duplicateClause}
     WHERE id = $1`,
    duplicateOfPaymentId
      ? [paymentId, providerTransactionId, metadataPatch, duplicateOfPaymentId]
      : [paymentId, providerTransactionId, metadataPatch],
  );
}

/** Locks a payment row FOR UPDATE by primary key (used by the second stage of start-payment). */
export async function lockPaymentById(db: DbClient, paymentId: string): Promise<PaymentRow | null> {
  const { rows } = await db.query<PaymentRow>(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  return rows[0] ?? null;
}

/** Every payment attempt for a booking, oldest first. Deliberately NOT locked: start-payment holds
 *  the booking lock, and payment-then-booking is the global lock order (see
 *  confirm-successful-payment.ts), so taking payment locks after the booking lock could deadlock. */
export async function listPaymentsForBooking(db: DbClient, bookingId: string): Promise<PaymentRow[]> {
  const { rows } = await db.query<PaymentRow>(
    `SELECT * FROM payments WHERE booking_id = $1 ORDER BY created_at, id`,
    [bookingId],
  );
  return rows;
}

/** Shallow-merges `patch` into payments.metadata (jsonb `||`). */
export async function mergePaymentMetadata(
  db: DbClient,
  paymentId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await db.query(`UPDATE payments SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb WHERE id = $1`, [
    paymentId,
    patch,
  ]);
}

/** Locks this booking's allocation rows (any status), in id order. Part of the fixed lock order:
 *  payment -> booking -> simulators -> allocations. */
export async function lockAllocationsForBooking(db: DbClient, bookingId: string): Promise<AllocationLockRow[]> {
  const { rows } = await db.query<AllocationLockRow>(
    `SELECT id, simulator_id, allocation_status, hold_expires_at,
            (allocation_status = 'hold' AND hold_expires_at <= now()) AS hold_expired
     FROM booking_allocations
     WHERE booking_id = $1
     ORDER BY id
     FOR UPDATE`,
    [bookingId],
  );
  return rows;
}

/** HOLD -> released for every hold row of the booking (expired or not) — a released row never
 *  blocks capacity and is never resurrected. */
export async function releaseHeldAllocations(db: DbClient, bookingId: string): Promise<void> {
  await db.query(
    `UPDATE booking_allocations
     SET allocation_status = 'released', hold_expires_at = NULL
     WHERE booking_id = $1 AND allocation_status = 'hold'`,
    [bookingId],
  );
}

/** Moves every HOLD row of the booking to a new expiry. */
export async function setHoldExpiry(db: DbClient, bookingId: string, holdExpiresAt: Date): Promise<void> {
  await db.query(
    `UPDATE booking_allocations SET hold_expires_at = $2 WHERE booking_id = $1 AND allocation_status = 'hold'`,
    [bookingId, holdExpiresAt],
  );
}

/** 'pending' -> 'cancelled' — used when a payment succeeded but the booking's capacity is gone. */
export async function cancelPendingBooking(db: DbClient, bookingId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE bookings SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [bookingId],
  );
  return rows.length > 0;
}

/** Moves a booking's currently-HOLD allocations to 'confirmed' and clears hold_expires_at — see
 *  002_simulator_inventory.sql's allocation_status comment, which reserved exactly this
 *  transition for a future payment step. Filtered to allocation_status = 'hold' so a repeat call
 *  (idempotent replay) is a no-op: already-'confirmed' rows are left untouched, and a 'released'
 *  row (a future cancellation feature) is never resurrected by a late payment confirmation. */
export async function confirmBookingAllocations(db: DbClient, bookingId: string): Promise<void> {
  await db.query(
    `UPDATE booking_allocations
     SET allocation_status = 'confirmed', hold_expires_at = NULL
     WHERE booking_id = $1 AND allocation_status = 'hold'`,
    [bookingId],
  );
}

/** Moves a booking from 'pending' to 'confirmed' — the only booking_status transition this phase
 *  writes (see 003_payment_foundation.sql's header on why booking_status itself needs no schema
 *  change). Filtered to status = 'pending' so an idempotent replay (booking already 'confirmed')
 *  is a harmless no-op rather than re-triggering the updated_at trigger. */
export async function confirmBookingStatus(db: DbClient, bookingId: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `UPDATE bookings SET status = 'confirmed' WHERE id = $1 AND status = 'pending' RETURNING id`,
    [bookingId],
  );
  return rows.length > 0;
}

export async function markPaymentFailed(db: DbClient, paymentId: string, failureReason: string): Promise<void> {
  await db.query(
    `UPDATE payments
     SET payment_status = 'failed', failure_reason = $2
     WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')`,
    [paymentId, failureReason],
  );
}

export async function markPaymentExpired(db: DbClient, paymentId: string): Promise<void> {
  await db.query(
    `UPDATE payments
     SET payment_status = 'expired'
     WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')`,
    [paymentId],
  );
}

/** 'created' -> 'pending': the provider has acknowledged the attempt and is now waiting on the
 *  customer/bank. A no-op once the attempt has moved past 'created' for any reason. */
export async function markPaymentPending(db: DbClient, paymentId: string): Promise<void> {
  await db.query(`UPDATE payments SET payment_status = 'pending' WHERE id = $1 AND payment_status = 'created'`, [
    paymentId,
  ]);
}

export interface CustomerBookingRow {
  id: string;
  booking_number: number;
  status: string;
  /** products.name — a display line for the provider's dashboard, never a pricing input. */
  product_name: string;
}

/** Ownership check AND read in one statement: the booking is returned only if bookings.cognito_sub
 *  equals the caller's verified JWT `sub`. The caller's identity is never taken from request data;
 *  a booking that exists but belongs to someone else is indistinguishable from one that doesn't
 *  exist (both return null). No lock — start-payment.ts takes its own booking lock afterwards. */
export async function findCustomerBooking(
  db: DbClient,
  bookingId: string,
  cognitoSub: string,
): Promise<CustomerBookingRow | null> {
  const { rows } = await db.query<CustomerBookingRow>(
    `SELECT b.id, b.booking_number, b.status, p.name AS product_name
     FROM bookings b
     JOIN products p ON p.id = b.product_id
     WHERE b.id = $1 AND b.cognito_sub = $2`,
    [bookingId, cognitoSub],
  );
  return rows[0] ?? null;
}

/** Latest expiry among the booking's live HOLD allocations (null when it has none — confirmed,
 *  released or never allocated). `hold_expired` uses the database clock, like every other
 *  availability/hold check. */
export async function getBookingHoldState(
  db: DbClient,
  bookingId: string,
): Promise<{ holdExpiresAt: Date | null; holdExpired: boolean }> {
  const { rows } = await db.query<{ hold_expires_at: Date | null; hold_expired: boolean | null }>(
    `SELECT max(hold_expires_at) AS hold_expires_at, COALESCE(bool_and(hold_expires_at <= now()), false) AS hold_expired
     FROM booking_allocations
     WHERE booking_id = $1 AND allocation_status = 'hold'`,
    [bookingId],
  );
  const row = rows[0];
  return { holdExpiresAt: row?.hold_expires_at ?? null, holdExpired: row?.hold_expired === true };
}

export interface ReconcilableAttempt {
  id: string;
  booking_id: string;
  provider: PaymentProvider;
  provider_order_id: string;
  payment_status: PaymentStatus;
  payment_environment: AppEnvironment | null;
}

/** Background-reconciliation candidates: open ('created'/'pending') PhonePe attempts that have a
 *  live provider order (metadata.checkout.redirectUrl is written only after the order exists —
 *  same test payment-status.ts uses). There is deliberately NO age cut-off: a customer who paid
 *  and never came back must still be reconciled however old the attempt is; stale-attempt cleanup
 *  is a separate policy. Terminal rows
 *  (paid/failed/expired/refunded) are never selected. Least-recently-checked first (falling back
 *  to created_at), so a bounded batch rotates through all open attempts instead of re-checking the
 *  same oldest rows. Read-only, no lock: confirmSuccessfulPayment locks per payment.
 *
 *  `environment` is required and filters on the typed payment_environment column, so one
 *  environment's reconciler can never pick up (and query its provider about) the other's rows:
 *  SANDBOX also selects transitional NULL rows; PRODUCTION selects PRODUCTION only, never NULL
 *  (see environment.ts's environmentMatchSql). */
export async function listPaymentsForReconciliation(
  db: DbClient,
  environment: AppEnvironment,
  limit: number,
): Promise<ReconcilableAttempt[]> {
  assertAppEnvironment(environment, 'environment');
  const { rows } = await db.query<ReconcilableAttempt>(
    `SELECT id, booking_id, provider, provider_order_id, payment_status, payment_environment
     FROM payments
     WHERE provider = 'phonepe'
       AND payment_status IN ('created', 'pending')
       AND ${environmentMatchSql('payment_environment', '$1', environment)}
       AND metadata #>> '{checkout,redirectUrl}' IS NOT NULL
     ORDER BY COALESCE((metadata ->> 'reconcileCheckedAt')::timestamptz, created_at), id
     LIMIT $2`,
    [environment, limit],
  );
  return rows;
}
