// Phase 3B: PATCH /admin/bookings/{id}/status — the whitelisted, pure transition-rule half. Kept
// DB-free (same split as opening-hours.ts/simulator-allocation.ts) so the rules themselves are
// directly unit-testable; admin-repository.ts's transitionBookingStatus() is the DB-touching half
// that calls isAllowedTransition() before writing anything.
//
// booking_status's real enum (see database/migrations/001_initial_schema.sql) is exactly
// 'pending' | 'confirmed' | 'cancelled' | 'completed' | 'no_show' — there is no 'checked_in' value
// today. This phase's brief asks for CHECKED_IN eventually, but explicitly says not to assume it
// exists and to only add a migration if genuinely necessary; see this phase's final report for why
// none is added here. Every transition below is therefore expressed only in terms of statuses that
// already exist in production.
//
// Never includes 'paid' anywhere: payment_status is a completely separate table/enum
// (003_payment_foundation.sql) that only confirm-successful-payment.ts writes — see that file's
// header and this phase's brief, item 8/9, for why a generic booking-status endpoint must never be
// the thing that marks a payment PAID.

export const BOOKING_STATUSES = ['pending', 'confirmed', 'cancelled', 'completed', 'no_show'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export function isValidBookingStatus(value: unknown): value is BookingStatus {
  return typeof value === 'string' && (BOOKING_STATUSES as readonly string[]).includes(value);
}

/**
 * The admin-driven transitions this phase supports — deliberately a small whitelist, not every
 * combinatorially possible from->to pair:
 *   pending   -> confirmed | cancelled   (an admin can manually confirm a walk-in/cash booking, or
 *                cancel one — confirming here never touches payments; see this file's header. This
 *                is an explicit manual/offline confirmation, e.g. a walk-in paid in cash at the
 *                counter — never a substitute for confirm-successful-payment.ts's PhonePe-driven
 *                confirmation. See confirmsAllocationOnTransition() below: admin-repository.ts's
 *                transitionBookingStatus() must confirm the booking's HOLD allocation(s) in the
 *                same transaction, exactly as a successful payment already does, so a booking is
 *                never left 'confirmed' while its allocation(s) are still a temporary, expirable
 *                HOLD — see this phase's audit brief, Issue 1.)
 *   confirmed -> cancelled | completed | no_show
 *   cancelled | completed | no_show -> (nothing; all three are terminal for this phase)
 * A booking already 'confirmed' via a successful payment (confirm-successful-payment.ts) can still
 * be cancelled/completed/no-showed by an admin through this same table — payment state is
 * unaffected either way, since this module never touches the payments table.
 */
const ALLOWED_TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['cancelled', 'completed', 'no_show'],
  cancelled: [],
  completed: [],
  no_show: [],
};

export function isAllowedTransition(from: BookingStatus, to: BookingStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Whether moving a booking to `to` should also release its simulator allocation(s) — see
 *  admin-repository.ts's transitionBookingStatus(). Today this is exactly the 'cancelled' target:
 *  a cancelled booking's future allocation must no longer block availability (this phase's brief,
 *  item 8's "critical example"). 'completed'/'no_show' both describe a session whose scheduled
 *  window has already passed by the time an admin marks it, so there is nothing left to release —
 *  the HOLD/confirmed window is already in the past and was never blocking anything going
 *  forward. */
export function releasesAllocationOnTransition(to: BookingStatus): boolean {
  return to === 'cancelled';
}

/** Whether moving a booking to `to` must also confirm its HOLD simulator allocation(s) — see
 *  admin-repository.ts's transitionBookingStatus(). Today this is exactly the 'confirmed' target:
 *  an admin manually confirming a pending booking (a walk-in/cash sale, confirmed offline — see
 *  this file's ALLOWED_TRANSITIONS comment) must never leave the booking 'confirmed' while its
 *  allocation(s) are still a temporary HOLD that can later expire (this phase's audit brief,
 *  Issue 1). This mirrors, but is entirely separate from, payment-repository.ts's
 *  confirmBookingAllocations() — the identical write a *successful payment* triggers via
 *  confirm-successful-payment.ts; admin-repository.ts reuses that same function rather than
 *  duplicating its SQL, so there is exactly one writer of "HOLD -> confirmed, hold_expires_at =
 *  NULL" regardless of which of the two flows triggers it. */
export function confirmsAllocationOnTransition(to: BookingStatus): boolean {
  return to === 'confirmed';
}
