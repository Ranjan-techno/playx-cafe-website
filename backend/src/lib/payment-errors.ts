// Phase 3A: typed errors for the payment domain layer (start-payment.ts,
// confirm-successful-payment.ts, sync-payment-status.ts).
//
// Each carries a stable, machine-readable `code` — same rationale as http.ts's errorResponse():
// a future webhook/admin handler can branch on `code` without string-matching `message`. These
// classes are plain domain errors, not HTTP responses themselves — no handler exists yet that
// throws these across a Lambda boundary (see this phase's brief: no webhook route is built yet).

export abstract class PaymentDomainError extends Error {
  abstract readonly code: string;
}

export class PaymentNotFoundError extends PaymentDomainError {
  readonly code = 'payment_not_found';
  constructor(provider: string, providerOrderId: string) {
    super(`No payment attempt found for provider "${provider}" order "${providerOrderId}"`);
  }
}

export class BookingNotFoundError extends PaymentDomainError {
  readonly code = 'booking_not_found';
  constructor(bookingId: string) {
    // Defensive only: payments.booking_id is a NOT NULL foreign key into bookings, so this should
    // be unreachable in practice — see confirm-successful-payment.ts's use of it.
    super(`No booking found for id "${bookingId}" (referenced by a payment row)`);
  }
}

export class PaymentBookingMismatchError extends PaymentDomainError {
  readonly code = 'payment_booking_mismatch';
  constructor(paymentId: string, expectedBookingId: string, actualBookingId: string) {
    super(
      `Payment "${paymentId}" belongs to booking "${actualBookingId}", not the expected booking "${expectedBookingId}"`,
    );
  }
}

/** Thrown when a payment attempt is already in a terminal, non-'paid' state (failed/expired/
 *  refunded) and a caller tries to confirm it as successful anyway. Attempts are one-shot: a
 *  genuinely new try is a new `payments` row (see start-payment.ts), never a status flip
 *  on an old one. */
export class PaymentAlreadyFinalizedError extends PaymentDomainError {
  readonly code = 'payment_already_finalized';
  constructor(paymentId: string, currentStatus: string) {
    super(`Payment "${paymentId}" is already "${currentStatus}" and cannot be marked paid`);
  }
}

export class AmountMismatchError extends PaymentDomainError {
  readonly code = 'amount_mismatch';
  constructor(expectedInr: string, reportedInr: string) {
    super(`Expected payment amount ₹${expectedInr}, but provider reported ₹${reportedInr}`);
  }
}

export class CurrencyMismatchError extends PaymentDomainError {
  readonly code = 'currency_mismatch';
  constructor(expected: string, reported: string) {
    super(`Expected currency "${expected}", but provider reported "${reported}"`);
  }
}

/** A *different* payment attempt for the same booking is already 'paid'. Confirming this one too
 *  would violate "one successful payment must not produce multiple booking confirmations" — see
 *  the payments_one_paid_per_booking partial unique index this mirrors at the application level. */
export class BookingAlreadyPaidError extends PaymentDomainError {
  readonly code = 'booking_already_paid';
  constructor(bookingId: string, existingPaymentId: string) {
    super(`Booking "${bookingId}" already has a successful payment ("${existingPaymentId}")`);
  }
}

/** The locked provider_transaction_id collided with a different payments row (the
 *  idx_payments_provider_transaction_id_unique partial unique index rejected the write) — the
 *  same real-world provider transaction was already recorded against a different attempt. */
export class DuplicateProviderTransactionError extends PaymentDomainError {
  readonly code = 'duplicate_provider_transaction';
  constructor(provider: string, providerTransactionId: string) {
    super(`Provider transaction "${providerTransactionId}" for "${provider}" is already recorded on another payment`);
  }
}

/** The booking is in a status ('cancelled'/'completed'/'no_show') that a successful payment must
 *  never silently confirm on top of. This should not happen in the normal flow (a booking with an
 *  active payment attempt is still 'pending') — surfaced as a distinct error so it's never
 *  silently swallowed, per the brief's "report that clearly" instruction. */
export class BookingNotConfirmableError extends PaymentDomainError {
  readonly code = 'booking_not_confirmable';
  constructor(bookingId: string, status: string) {
    super(`Booking "${bookingId}" is "${status}" and can no longer be confirmed by a successful payment`);
  }
}

export class BookingNotPayableError extends PaymentDomainError {
  readonly code = 'booking_not_payable';
  constructor(bookingId: string, status: string) {
    super(`Booking "${bookingId}" is "${status}" — only a "pending" booking can start a new payment attempt`);
  }
}

/** The PhonePe (or other provider) call failed. Messages carry only the HTTP status/provider
 *  error code — never a response body, which could echo request data. `definiteRejection` is true
 *  only when the provider answered with a 4xx, i.e. we know no order was created; a timeout,
 *  network error or 5xx is ambiguous (the order may exist), and callers must not assume it
 *  doesn't. */
export class PaymentProviderError extends PaymentDomainError {
  readonly code = 'payment_provider_error';
  constructor(
    message: string,
    readonly definiteRejection: boolean,
    readonly httpStatusCode?: number,
    readonly providerCode?: string,
  ) {
    super(message);
  }
}

/** getOrderStatus reported the order does not exist at the provider. */
export class PaymentProviderOrderNotFoundError extends PaymentDomainError {
  readonly code = 'payment_provider_order_not_found';
  constructor() {
    super('The payment provider has no record of this order');
  }
}

/** Another start-payment call for this booking is (or may still be) creating its provider order. */
export class PaymentStartInProgressError extends PaymentDomainError {
  readonly code = 'payment_start_in_progress';
  constructor(bookingId: string) {
    super(`A payment for booking "${bookingId}" is already being started — retry shortly`);
  }
}

/** The booking's simulator hold lapsed and can no longer be re-established for checkout. */
export class HoldExpiredError extends PaymentDomainError {
  readonly code = 'hold_expired';
  constructor(bookingId: string) {
    super(`The simulator hold for booking "${bookingId}" has expired and cannot be extended again — please rebook`);
  }
}

/** The hold had lapsed and the simulator capacity it needed is no longer free. */
export class SimulatorCapacityUnavailableError extends PaymentDomainError {
  readonly code = 'simulator_capacity_unavailable';
  constructor(bookingId: string) {
    super(`Simulator capacity for booking "${bookingId}" is no longer available`);
  }
}

/** Not enough time left before the session starts / hold expires to run a checkout. */
export class CheckoutWindowClosedError extends PaymentDomainError {
  readonly code = 'checkout_window_closed';
  constructor(bookingId: string) {
    super(`Booking "${bookingId}" no longer has enough time left to complete a payment`);
  }
}

/** The booking (or an existing attempt on it) belongs to a different SANDBOX/PRODUCTION environment
 *  than the payment provider this Lambda is configured for. A sandbox backend must never take (or
 *  reconcile) a payment for a production booking, and vice versa. */
export class PaymentEnvironmentMismatchError extends PaymentDomainError {
  readonly code = 'payment_environment_mismatch';
  constructor(bookingId: string, expected: string, actual: string | null) {
    super(`Booking "${bookingId}" belongs to environment "${actual ?? 'NULL'}", not "${expected}"`);
  }
}
