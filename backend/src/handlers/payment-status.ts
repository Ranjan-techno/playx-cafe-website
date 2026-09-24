import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { storedEnvironmentMatches, type AppEnvironment } from '../lib/environment';
import { errorResponse, jsonResponse } from '../lib/http';
import { PaymentDomainError, PaymentProviderError, PaymentProviderOrderNotFoundError } from '../lib/payment-errors';
import { UUID_RE, mapPaymentError, readIdentity } from '../lib/payment-http';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import {
  findCustomerBooking,
  getBookingHoldState,
  listPaymentsForBooking,
  type PaymentRow,
} from '../lib/payment-repository';
import { PhonePeConfigError } from '../lib/phonepe-config';
import { getPhonePePaymentProvider } from '../lib/phonepe-runtime';
import { reconcilePayment } from '../lib/reconcile-payment';

// GET /payments/{bookingId}/status — what became of the caller's payment for one booking.
//
// Cognito-JWT-protected. Ownership is enforced in SQL (bookings.cognito_sub = the verified `sub`):
// customer A asking about customer B's booking gets the same 404 as a booking that doesn't exist.
//
// The browser's return from PhonePe is NEVER treated as proof of payment. If the current attempt is
// still open (created/pending with a live checkout), this asks PhonePe directly via the Phase-1
// reconcilePayment() -> applyProviderOutcome() -> confirmSuccessfulPayment() path — the only code
// that can mark a payment PAID or confirm a booking — then reports what the DATABASE says after
// that. A transient provider failure never fails the poll: the caller just sees the last known
// state and polls again.
//
// ENVIRONMENT: an open attempt is reconciled only when its typed payments.payment_environment
// belongs to the provider's configured environment (strict typed match; NULL/unknown matches
// nothing and is never reconciled, see lib/environment.ts). This sandbox Lambda therefore never asks its sandbox PhonePe client
// about an explicitly PRODUCTION payment: the provider is not called and the last known DB state
// is reported instead.

export type PaymentOutcome =
  | 'not_started'
  | 'pending'
  | 'confirmed'
  | 'refund_required'
  | 'failed'
  | 'expired'
  | 'hold_expired';

export interface PaymentStatusDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getProvider: () => Promise<PaymentProviderAdapter & { environment: AppEnvironment }>;
}

const defaultDeps: PaymentStatusDeps = { getDb, resetDb, getProvider: () => getPhonePePaymentProvider() };

function hasLiveCheckout(payment: PaymentRow): boolean {
  const checkout = payment.metadata?.checkout as { redirectUrl?: unknown } | undefined;
  return typeof checkout?.redirectUrl === 'string';
}

/** The attempt the customer cares about: the paid one that confirmed the booking if any (never a
 *  duplicate second payment, which is only a refund matter), else the most recent. */
function currentPayment(payments: PaymentRow[]): PaymentRow | undefined {
  return (
    payments.find((p) => p.payment_status === 'paid' && !p.duplicate_of_payment_id) ??
    payments[payments.length - 1]
  );
}

export function createHandler(deps: PaymentStatusDeps = defaultDeps) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    const identity = readIdentity(event);
    if (!identity) {
      return errorResponse(401, 'unauthenticated', 'Missing subject claim');
    }
    const rawId = event.pathParameters?.bookingId;
    if (typeof rawId !== 'string' || !UUID_RE.test(rawId)) {
      return errorResponse(400, 'invalid_request', 'A valid bookingId is required');
    }
    const bookingId = rawId.toLowerCase();

    try {
      const db = await deps.getDb();
      let booking = await findCustomerBooking(db, bookingId, identity.sub);
      if (!booking) {
        return errorResponse(404, 'booking_not_found', 'Booking not found');
      }

      let payments = await listPaymentsForBooking(db, bookingId);
      const open = [...payments].reverse().find(
        (p) => (p.payment_status === 'created' || p.payment_status === 'pending') && hasLiveCheckout(p),
      );
      if (open && !payments.some((p) => p.payment_status === 'paid')) {
        try {
          const provider = await deps.getProvider();
          if (storedEnvironmentMatches(open.payment_environment, provider.environment)) {
            await reconcilePayment(db, provider, open.provider_order_id);
          } else {
            console.error('GET /payments/status reconcile refused: payment environment does not match the provider');
          }
        } catch (err) {
          // Provider/credential trouble or a domain-level refusal: keep the last known state.
          if (
            !(err instanceof PaymentProviderError) &&
            !(err instanceof PaymentProviderOrderNotFoundError) &&
            !(err instanceof PhonePeConfigError) &&
            !(err instanceof PaymentDomainError)
          ) {
            throw err;
          }
          console.error('GET /payments/status reconcile skipped', err.name, err.message);
        }
        // Re-read what reconciliation may have changed.
        const fresh = await findCustomerBooking(db, bookingId, identity.sub);
        if (!fresh) {
          return errorResponse(404, 'booking_not_found', 'Booking not found');
        }
        booking = fresh;
        payments = await listPaymentsForBooking(db, bookingId);
      }

      const payment = currentPayment(payments);
      const hold = await getBookingHoldState(db, bookingId);
      const paymentStatus = payment?.payment_status ?? null;

      let outcome: PaymentOutcome;
      if (payment?.payment_status === 'paid') {
        if (payment.metadata?.refundRequired === true) {
          outcome = 'refund_required';
        } else {
          // Paid and the booking is confirmed; a paid-but-unconfirmed row without the refund flag
          // should be impossible (one transaction) — report it as still being settled, not retryable.
          outcome = booking.status === 'confirmed' ? 'confirmed' : 'pending';
        }
      } else if (payment && (payment.payment_status === 'created' || payment.payment_status === 'pending')) {
        // Even past the hold, an unresolved provider order may still turn out paid.
        outcome = 'pending';
      } else if (booking.status === 'pending' && payment === undefined && !hold.holdExpiresAt) {
        outcome = 'hold_expired';
      } else if (booking.status === 'pending' && hold.holdExpired) {
        outcome = 'hold_expired';
      } else if (payment?.payment_status === 'failed') {
        outcome = 'failed';
      } else if (payment?.payment_status === 'expired') {
        outcome = 'expired';
      } else if (payment === undefined) {
        outcome = 'not_started';
      } else {
        outcome = 'failed'; // 'refunded' never reaches here for a customer flow; be conservative.
      }

      const canRetry = booking.status === 'pending' && (outcome === 'failed' || outcome === 'expired' || outcome === 'not_started');

      return jsonResponse(200, {
        bookingId,
        bookingNumber: booking.booking_number,
        bookingStatus: booking.status,
        paymentStatus,
        outcome,
        holdExpiresAt: hold.holdExpiresAt ? hold.holdExpiresAt.toISOString() : null,
        canRetry,
      });
    } catch (err) {
      const mapped = mapPaymentError(err);
      if (mapped) {
        console.error('GET /payments/status rejected', err instanceof Error ? err.name : 'unknown');
        return mapped;
      }
      deps.resetDb();
      console.error('GET /payments/status failed', err instanceof Error ? err.name : 'unknown');
      return errorResponse(500, 'internal_error', 'Failed to load payment status');
    }
  };
}

export const handler = createHandler();
