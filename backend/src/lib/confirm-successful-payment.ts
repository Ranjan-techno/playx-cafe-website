// Phase 3A: BOOKING HOLD -> PAYMENT PAID -> BOOKING CONFIRMED -> ALLOCATION CONFIRMED, atomically.
//
// This is the one function later a real webhook/verification handler calls once — and only once
// it has *independently verified* (via PaymentProviderAdapter.verifyWebhook/getPaymentStatus, see
// payment-provider.ts) that a payment genuinely succeeded. confirmSuccessfulPayment() itself never
// talks to a provider and never re-verifies a signature; it trusts its caller on that single
// point, exactly like allocate-simulators.ts trusts create-booking.ts to have already validated
// the request — everything *this* function is responsible for (amount, currency, idempotency,
// booking state, atomicity) it still checks itself against server-controlled data.
//
// Owns its own transaction (BEGIN/COMMIT/ROLLBACK) rather than expecting a caller to have already
// opened one — unlike allocateSimulators() (a sub-step of create-booking.ts's larger booking-
// creation transaction), this is a complete, self-contained unit of work with nothing else to
// share a transaction with. Mirrors create-booking.ts's own top-level BEGIN/COMMIT/ROLLBACK style.
//
// Locking order — payments row, then bookings row — is fixed and never reversed anywhere else in
// this codebase that touches both tables, so two concurrent confirmations (including for the same
// booking via two different payment attempts) can never deadlock against each other.

import type { DbClient } from './allocate-simulators';
import {
  AmountMismatchError,
  BookingAlreadyPaidError,
  BookingNotConfirmableError,
  BookingNotFoundError,
  CurrencyMismatchError,
  DuplicateProviderTransactionError,
  PaymentAlreadyFinalizedError,
  PaymentBookingMismatchError,
  PaymentNotFoundError,
} from './payment-errors';
import {
  TERMINAL_NON_PAID_STATUSES,
  confirmBookingAllocations,
  confirmBookingStatus,
  findOtherPaidPaymentForBooking,
  lockBookingForPayment,
  lockPaymentByProviderOrderId,
  markPaymentPaid,
  type PaymentProvider,
} from './payment-repository';

// Booking statuses a successful payment is still allowed to land on. 'confirmed' is included so a
// duplicate-callback replay (see below) that reaches this far is a harmless no-op, not an error.
const CONFIRMABLE_BOOKING_STATUSES = new Set(['pending', 'confirmed']);

export interface ConfirmSuccessfulPaymentInput {
  provider: PaymentProvider;
  /** Identifies the payment attempt — see lockPaymentByProviderOrderId's doc comment for why this
   *  (not payments.id) is the natural key a verified provider callback carries. */
  providerOrderId: string;
  /** Optional defensive check ("verify the payment belongs to that booking" — item 3 of this
   *  phase's confirmation-flow requirements): if the caller already knows which booking it expects
   *  this callback to be about, passing it here catches a caller-side bug (wrong lookup, stale
   *  cache) before anything is written. Omit when the caller has no independent expectation. */
  expectedBookingId?: string;
  /** The amount the provider reports as actually paid, in rupees. Checked against
   *  payments.amount_inr (set at attempt-creation time from the booking's own price — see
   *  create-payment-attempt.ts) — this parameter is provider-reported, therefore untrusted, and is
   *  never written anywhere on its own say-so. */
  amountInr: number;
  currency?: string;
  /** The provider's own transaction id for this successful attempt, if the provider supplies one.
   *  Recorded on the payment row; a collision with a different payment's transaction id is
   *  rejected (see DuplicateProviderTransactionError). */
  providerTransactionId?: string | null;
}

export interface ConfirmSuccessfulPaymentResult {
  paymentId: string;
  bookingId: string;
  /** True when this call found the payment already 'paid' (a duplicate provider callback) and
   *  made no changes — the caller (a future webhook handler) can log this distinctly from a fresh
   *  confirmation without it being an error. */
  alreadyConfirmed: boolean;
}

function normalizeAmount(value: number | string): string {
  return Number(value).toFixed(2);
}

/**
 * Confirms one payment attempt as successfully paid and, in the same transaction, confirms the
 * booking it belongs to and its simulator allocations. Safe to call more than once for the exact
 * same successful attempt (provider callbacks can and do arrive more than once) — see this
 * module's tests for the idempotency guarantees this provides.
 *
 * Throws (and always ROLLBACKs first) rather than returning an error value, since every failure
 * case here is either a genuine bug/attack (amount or currency mismatch, a payment/booking that
 * doesn't exist, a booking already paid by a different attempt) or a state the caller must
 * explicitly decide how to handle (a 'failed'/'expired' attempt being reported successful, which
 * should never happen for a well-behaved provider) — never a routine, ignorable outcome.
 */
export async function confirmSuccessfulPayment(
  db: DbClient,
  input: ConfirmSuccessfulPaymentInput,
): Promise<ConfirmSuccessfulPaymentResult> {
  const expectedCurrency = input.currency ?? 'INR';

  try {
    await db.query('BEGIN');

    // 1. Identify and lock the payment record safely.
    const payment = await lockPaymentByProviderOrderId(db, input.provider, input.providerOrderId);
    if (!payment) {
      throw new PaymentNotFoundError(input.provider, input.providerOrderId);
    }

    // 2. Identify and lock the related booking.
    const booking = await lockBookingForPayment(db, payment.booking_id);
    if (!booking) {
      throw new BookingNotFoundError(payment.booking_id);
    }

    // 3. Verify the payment belongs to that booking (only meaningful when the caller supplied an
    // independent expectation — see the field's doc comment).
    if (input.expectedBookingId !== undefined && input.expectedBookingId !== payment.booking_id) {
      throw new PaymentBookingMismatchError(payment.id, input.expectedBookingId, payment.booking_id);
    }

    // 5. Safely handle an already-paid attempt: a duplicate provider callback for a payment this
    // function already confirmed. Checked before amount/currency validation so a harmless replay
    // is never rejected over an incidental formatting difference in a repeated callback body.
    if (payment.payment_status === 'paid') {
      await db.query('COMMIT');
      return { paymentId: payment.id, bookingId: payment.booking_id, alreadyConfirmed: true };
    }

    if (TERMINAL_NON_PAID_STATUSES.includes(payment.payment_status)) {
      throw new PaymentAlreadyFinalizedError(payment.id, payment.payment_status);
    }
    // Only 'created' or 'pending' reach this point — both are valid predecessors of 'paid'.

    // 4. Validate expected amount/currency using server-controlled values (payments.amount_inr/
    // currency, set at attempt-creation time from the booking's own price — never from this call's
    // input alone, and never from the browser at any point in the flow).
    if (normalizeAmount(input.amountInr) !== normalizeAmount(payment.amount_inr)) {
      throw new AmountMismatchError(normalizeAmount(payment.amount_inr), normalizeAmount(input.amountInr));
    }
    if (expectedCurrency !== payment.currency) {
      throw new CurrencyMismatchError(payment.currency, expectedCurrency);
    }

    if (!CONFIRMABLE_BOOKING_STATUSES.has(booking.status)) {
      throw new BookingNotConfirmableError(booking.id, booking.status);
    }

    // Application-level mirror of idx_payments_one_paid_per_booking, checked up front for a clear
    // error — the index itself (see markPaymentPaid below) is the DB-level backstop if this check
    // and the UPDATE ever race (they can't within one locked booking row, but the constraint is
    // kept regardless; see the migration's comment on it).
    const otherPaid = await findOtherPaidPaymentForBooking(db, booking.id, payment.id);
    if (otherPaid) {
      throw new BookingAlreadyPaidError(booking.id, otherPaid.id);
    }

    // 6-8. Mark payment PAID, recording the provider transaction id (if supplied) and paid_at.
    try {
      await markPaymentPaid(db, payment.id, input.providerTransactionId ?? null);
    } catch (err) {
      if (isUniqueViolation(err, 'idx_payments_provider_transaction_id_unique')) {
        throw new DuplicateProviderTransactionError(input.provider, input.providerTransactionId ?? '');
      }
      if (isUniqueViolation(err, 'idx_payments_one_paid_per_booking')) {
        // Belt-and-suspenders: the up-front findOtherPaidPaymentForBooking check above should
        // already have caught this: this branch only fires against something like the fake test
        // DB or a genuinely concurrent write this transaction's own booking-row lock should have
        // serialized against.
        throw new BookingAlreadyPaidError(booking.id, 'unknown');
      }
      throw err;
    }

    // 9-10. Transition this booking's HOLD allocations to CONFIRMED and clear hold_expires_at.
    await confirmBookingAllocations(db, booking.id);

    // 11. Update booking state compatibly with the existing bookings.status enum (see
    // 003_payment_foundation.sql's header) — a no-op if it's already 'confirmed' (idempotent
    // replay).
    await confirmBookingStatus(db, booking.id);

    // 12. Commit atomically.
    await db.query('COMMIT');

    return { paymentId: payment.id, bookingId: booking.id, alreadyConfirmed: false };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Best-effort check for a Postgres unique-violation (SQLSTATE 23505) on a specific named
 *  constraint/index — pg populates `.code`/`.constraint` on the error object it throws. Written
 *  defensively (optional chaining, no assumed error shape) since this also runs against
 *  hand-written fakes in tests, which model the same fields without being real pg errors. */
function isUniqueViolation(err: unknown, constraintName: string): boolean {
  const e = err as { code?: string; constraint?: string } | null | undefined;
  return e?.code === '23505' && e?.constraint === constraintName;
}
