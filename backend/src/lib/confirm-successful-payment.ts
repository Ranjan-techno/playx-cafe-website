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
// LOCK ORDER — fixed for every transaction in this codebase that touches these tables:
//   payment -> booking -> simulators (all active, ORDER BY code) -> booking_allocations
// (create-booking takes simulators via allocateSimulators(); see booking-capacity.ts.) Never
// reversed anywhere, so no two of these can deadlock.
//
// LATE PAYMENT: the provider's SUCCESS is truth about the money, but says nothing about whether
// our simulator hold is still ours. Confirmation therefore goes through secureBookingCapacity():
//   - hold still valid                      -> confirm normally
//   - hold expired, capacity still free      -> re-allocate (same rig if free, else another of the
//                                                right type) under the simulators lock, confirm
//   - hold expired, capacity gone            -> payment is recorded PAID (the money did move),
//                                                booking is NOT confirmed (cancelled, its stale
//                                                holds released), payments.metadata carries
//                                                refundRequired=true + a reason. Refund is manual
//                                                in v1. A booking is never double-booked.
//
// SECOND SUCCESS: if the booking already has a primary paid payment and a different (historical)
// order for it is later reported SUCCESS, the money really was collected twice. That fact is never
// discarded: the second payment is recorded PAID (duplicate_of_payment_id -> the primary one),
// flagged refundRequired + manualReview, and the booking/allocations are left exactly as the first
// payment left them. No refund is ever claimed as done — it is a manual action for support.
//
// STAGE 2F — BOOKING-CONFIRMATION EMAIL: the two branches that leave payment=PAID + booking=CONFIRMED
// for the first time also insert the booking's one 'BOOKING_CONFIRMED' outbox row
// (booking-notifications.ts), inside this same transaction and under a SAVEPOINT — so the row exists
// iff the confirmation committed, and an insert failure can never fail the confirmation. The email
// itself is sent later by the scheduled sender, never from here. alreadyConfirmed replays, duplicate
// payments and refund_required outcomes enqueue nothing.

import type { DbClient } from './allocate-simulators';
import {
  AmountMismatchError,
  BookingAlreadyPaidError,
  BookingNotFoundError,
  CurrencyMismatchError,
  DuplicateProviderTransactionError,
  PaymentAlreadyFinalizedError,
  PaymentBookingMismatchError,
  PaymentNotFoundError,
} from './payment-errors';
import { secureBookingCapacity } from './booking-capacity';
import { enqueueBookingConfirmedNotification, type EnqueueResult } from './booking-notifications';
import { inrToPaise } from './money';
import {
  TERMINAL_NON_PAID_STATUSES,
  cancelPendingBooking,
  confirmBookingStatus,
  findOtherPaidPaymentForBooking,
  lockBookingForPayment,
  lockPaymentByProviderOrderId,
  markPaymentPaid,
  type PaymentProvider,
  type PaymentRow,
} from './payment-repository';


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
   *  start-payment.ts) — this parameter is provider-reported, therefore untrusted, and is
   *  never written anywhere on its own say-so. */
  amountInr: number | string;
  currency?: string;
  /** The provider's own transaction id for this successful attempt, if the provider supplies one.
   *  Recorded on the payment row; a collision with a different payment's transaction id is
   *  rejected (see DuplicateProviderTransactionError). */
  providerTransactionId?: string | null;
}

/** What the successful payment did to the booking.
 *   confirmed                       - hold was valid; booking + allocations confirmed.
 *   confirmed_after_reallocation    - hold had expired but capacity was free; re-allocated, confirmed.
 *   refund_required                 - payment is PAID but the booking could NOT be confirmed (no
 *                                     capacity, or booking already cancelled); metadata.refundRequired
 *                                     is set for manual refund. */
export type PaymentConfirmationOutcome = 'confirmed' | 'confirmed_after_reallocation' | 'refund_required';

export interface ConfirmSuccessfulPaymentResult {
  paymentId: string;
  bookingId: string;
  /** True when this call found the payment already 'paid' (a duplicate provider callback) and
   *  made no changes — `outcome` then reports what the original confirmation did. */
  alreadyConfirmed: boolean;
  outcome: PaymentConfirmationOutcome;
  /** Set when this payment is a second collected payment for an already-paid booking: the id of
   *  the payment that actually confirmed the booking. `outcome` is then 'refund_required'. */
  duplicateOfPaymentId?: string;
  /** Stage 2F: set only when this call confirmed the booking — whether its confirmation-email
   *  outbox row was written ('queued'), already existed, or could not be written ('not_queued'). */
  confirmationNotification?: EnqueueResult;
}

/** Exact comparison in integer paise — never floating point. A malformed reported amount is a
 *  mismatch, not a crash. */
function toPaiseOrNull(value: number | string): number | null {
  try {
    return inrToPaise(value);
  } catch {
    return null;
  }
}

function duplicateOfFromRow(payment: PaymentRow): string | undefined {
  return payment.duplicate_of_payment_id ?? undefined;
}

function outcomeOfPaidPayment(metadata: Record<string, unknown> | null): PaymentConfirmationOutcome {
  if (metadata?.refundRequired === true) {
    return 'refund_required';
  }
  const late = metadata?.lateConfirmation as { reallocated?: boolean } | undefined;
  return late?.reallocated === true ? 'confirmed_after_reallocation' : 'confirmed';
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

    // Safely handle an already-paid attempt: a duplicate provider callback for a payment this
    // function already confirmed. Checked before amount/currency validation so a harmless replay
    // is never rejected over an incidental formatting difference in a repeated callback body.
    if (payment.payment_status === 'paid') {
      await db.query('COMMIT');
      const duplicateOf = duplicateOfFromRow(payment);
      return {
        paymentId: payment.id,
        bookingId: payment.booking_id,
        alreadyConfirmed: true,
        outcome: outcomeOfPaidPayment(payment.metadata),
        ...(duplicateOf ? { duplicateOfPaymentId: duplicateOf } : {}),
      };
    }

    if (TERMINAL_NON_PAID_STATUSES.includes(payment.payment_status)) {
      throw new PaymentAlreadyFinalizedError(payment.id, payment.payment_status);
    }
    // Only 'created' or 'pending' reach this point — both are valid predecessors of 'paid'.

    // Validate expected amount/currency using server-controlled values (payments.amount_inr/
    // currency, set at attempt-creation time from the booking's own price — never from this call's
    // input alone, and never from the browser at any point in the flow). Compared in integer paise.
    const reportedPaise = toPaiseOrNull(input.amountInr);
    const expectedPaise = toPaiseOrNull(payment.amount_inr);
    if (reportedPaise === null || expectedPaise === null || reportedPaise !== expectedPaise) {
      throw new AmountMismatchError(String(payment.amount_inr), reportedPaise === null ? 'invalid' : String(input.amountInr));
    }
    if (expectedCurrency !== payment.currency) {
      throw new CurrencyMismatchError(payment.currency, expectedCurrency);
    }

    // Application-level mirror of idx_payments_one_paid_per_booking (which only constrains PRIMARY
    // paid payments — see 005_duplicate_payment_recording.sql). Another primary payment already
    // confirmed this booking, so this one is a duplicate collection, handled below after markPaid.
    const otherPaid = await findOtherPaidPaymentForBooking(db, booking.id, payment.id);

    const markPaid = async (metadataPatch: Record<string, unknown> | null, duplicateOfPaymentId: string | null = null): Promise<void> => {
      try {
        await markPaymentPaid(db, payment.id, input.providerTransactionId ?? null, metadataPatch, duplicateOfPaymentId);
      } catch (err) {
        if (isUniqueViolation(err, 'idx_payments_provider_transaction_id_unique')) {
          throw new DuplicateProviderTransactionError(input.provider, input.providerTransactionId ?? '');
        }
        if (isUniqueViolation(err, 'idx_payments_one_paid_per_booking')) {
          throw new BookingAlreadyPaidError(booking.id, 'unknown');
        }
        throw err;
      }
    };
    const detectedAt = new Date().toISOString();

    // The money moved, so the payment is recorded PAID in every branch below — truthfully.

    if (otherPaid) {
      // Second collected payment for a booking a different payment already confirmed. Record the
      // provider's truth; never touch the booking or its allocations (no double-confirm, no
      // double-allocate) and never claim a refund happened — support must refund it manually.
      await markPaid(
        {
          refundRequired: true,
          manualReview: true,
          reason: 'duplicate_payment_booking_already_paid',
          duplicateOfPaymentId: otherPaid.id,
          detectedAt,
        },
        otherPaid.id,
      );
      await db.query('COMMIT');
      return {
        paymentId: payment.id,
        bookingId: booking.id,
        alreadyConfirmed: false,
        outcome: 'refund_required',
        duplicateOfPaymentId: otherPaid.id,
      };
    }

    if (booking.status === 'cancelled' || booking.status === 'completed' || booking.status === 'no_show') {
      // A paid attempt landed on a booking that is already terminal. Never resurrect it; record
      // the payment and flag it for manual refund.
      await markPaid({ refundRequired: true, reason: `booking_${booking.status}`, detectedAt });
      await db.query('COMMIT');
      return { paymentId: payment.id, bookingId: booking.id, alreadyConfirmed: false, outcome: 'refund_required' };
    }

    if (booking.status === 'confirmed') {
      // Already confirmed (e.g. an admin confirmed it, which itself secured capacity). Record the
      // payment; do not touch allocations. This payment is what makes it a paid confirmation, so the
      // customer's confirmation email is queued here too (at most once per booking regardless).
      await markPaid(null);
      const notification = await enqueueBookingConfirmedNotification(db, booking.id);
      await db.query('COMMIT');
      logNotificationQueued(booking.id, notification);
      return { paymentId: payment.id, bookingId: booking.id, alreadyConfirmed: false, outcome: 'confirmed', confirmationNotification: notification };
    }

    // booking.status === 'pending': secure capacity under the simulators lock (payment and booking
    // are already locked, so the global order holds), then confirm or refuse.
    const capacity = await secureBookingCapacity(db, booking);

    if (capacity.kind === 'unavailable') {
      await markPaid({
        refundRequired: true,
        reason: 'hold_expired_capacity_unavailable',
        lateConfirmation: { reallocated: false, previousSimulatorIds: capacity.previousSimulatorIds, detectedAt },
        bookingDisposition: 'cancelled',
      });
      // Obsolete holds were already released by secureBookingCapacity(); the booking is cancelled
      // so it can't be paid again or mistaken for a live one. Deterministic state for manual
      // refund: payment=paid, refundRequired=true, booking=cancelled, no live allocation.
      await cancelPendingBooking(db, booking.id);
      await db.query('COMMIT');
      return { paymentId: payment.id, bookingId: booking.id, alreadyConfirmed: false, outcome: 'refund_required' };
    }

    if (capacity.kind === 'reallocated') {
      await markPaid({
        lateConfirmation: {
          reallocated: true,
          sameSimulators: capacity.sameSimulators,
          previousSimulatorIds: capacity.previousSimulatorIds,
          simulatorIds: capacity.simulatorIds,
          detectedAt,
        },
      });
    } else {
      await markPaid(null);
    }
    await confirmBookingStatus(db, booking.id);
    const notification = await enqueueBookingConfirmedNotification(db, booking.id);
    await db.query('COMMIT');
    logNotificationQueued(booking.id, notification);

    return {
      paymentId: payment.id,
      bookingId: booking.id,
      alreadyConfirmed: false,
      outcome: capacity.kind === 'reallocated' ? 'confirmed_after_reallocation' : 'confirmed',
      confirmationNotification: notification,
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Logged only after COMMIT, so "queued" always means the row is durable. 'not_queued' was already
 *  logged (as an error) by the enqueue itself. */
function logNotificationQueued(bookingId: string, result: EnqueueResult): void {
  if (result === 'queued') {
    console.log('booking confirmation notification queued', JSON.stringify({ bookingId }));
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
