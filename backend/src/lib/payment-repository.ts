// Phase 3A: the DB-touching half of the payment domain layer — thin CRUD/lookup helpers against
// `payments` (and the couple of `bookings` columns confirm-successful-payment.ts needs), matching
// the split allocate-simulators.ts/simulator-allocation.ts already established: this file only
// issues SQL, with no allocation/confirmation policy of its own — that lives in
// create-payment-attempt.ts and confirm-successful-payment.ts, which call these.
//
// Reuses allocate-simulators.ts's DbClient — the same minimal `query(text, params)` surface
// db.ts's getDb() already satisfies, and the same shape lib/test-support/fake-*.ts fakes
// implement for tests. Defined once there rather than a second time here.

import type { DbClient } from './allocate-simulators';

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
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

export interface BookingForPaymentRow {
  id: string;
  status: string;
  price_inr: string;
}

export interface CreatePaymentAttemptInput {
  bookingId: string;
  provider: PaymentProvider;
  providerOrderId: string;
  amountInr: string;
  currency?: string;
  metadata?: Record<string, unknown> | null;
}

/** Inserts a new 'created' payment attempt row. Never sets payment_status to anything but the
 *  column default ('created') — a caller advances it later via markPaymentPending/
 *  confirmSuccessfulPayment/markPaymentFailed/markPaymentExpired, each a deliberate, auditable
 *  transition rather than this function guessing an initial state. */
export async function createPaymentAttempt(db: DbClient, input: CreatePaymentAttemptInput): Promise<PaymentRow> {
  const { rows } = await db.query<PaymentRow>(
    `INSERT INTO payments (booking_id, provider, provider_order_id, amount_inr, currency, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [input.bookingId, input.provider, input.providerOrderId, input.amountInr, input.currency ?? 'INR', input.metadata ?? null],
  );
  return rows[0];
}

/** Locks a booking row (id, status, price_inr) FOR UPDATE — the "server-controlled expected
 *  amount" both create-payment-attempt.ts and confirm-successful-payment.ts check against is
 *  always read from here, never from the browser. Returns null if the booking doesn't exist
 *  (defensive only — payments.booking_id is a NOT NULL FK, so this should be unreachable once a
 *  payment row exists). */
export async function lockBookingForPayment(db: DbClient, bookingId: string): Promise<BookingForPaymentRow | null> {
  const { rows } = await db.query<BookingForPaymentRow>(
    `SELECT id, status, price_inr FROM bookings WHERE id = $1 FOR UPDATE`,
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

/** Any *other* 'paid' payment already recorded for this booking — the application-level mirror of
 *  the idx_payments_one_paid_per_booking partial unique index, checked before attempting the
 *  UPDATE below so a real double-payment produces a clear BookingAlreadyPaidError instead of a raw
 *  constraint-violation. `excludePaymentId` is the attempt currently being confirmed, so it never
 *  matches itself. */
export async function findOtherPaidPaymentForBooking(
  db: DbClient,
  bookingId: string,
  excludePaymentId: string,
): Promise<{ id: string } | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM payments WHERE booking_id = $1 AND payment_status = 'paid' AND id <> $2`,
    [bookingId, excludePaymentId],
  );
  return rows[0] ?? null;
}

/** The one writer of payment_status = 'paid'. Only called after every validation in
 *  confirm-successful-payment.ts has already passed — this function itself has no policy, it just
 *  performs the write (and lets a unique-constraint violation on provider_transaction_id surface
 *  to the caller, which translates it into DuplicateProviderTransactionError). */
export async function markPaymentPaid(
  db: DbClient,
  paymentId: string,
  providerTransactionId: string | null,
): Promise<void> {
  await db.query(
    `UPDATE payments
     SET payment_status = 'paid',
         provider_transaction_id = COALESCE($2, provider_transaction_id),
         paid_at = now()
     WHERE id = $1`,
    [paymentId, providerTransactionId],
  );
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
