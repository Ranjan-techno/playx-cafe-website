// Shared HTTP plumbing for the two customer payment endpoints (handlers/payment-start.ts,
// handlers/payment-status.ts): identity extraction from the verified JWT claims, request-id
// validation, redirect-URL vetting, and the single domain-error -> HTTP-status mapping.
//
// Error responses are deliberately generic: `error` is a stable code, `message` a fixed sentence.
// Nothing from PhonePe, AWS or Postgres (whose messages can echo request data or credentials) ever
// reaches a response body — full details go to the log via the caller's console.error.

import type { APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { errorResponse } from './http';
import {
  BookingAlreadyPaidError,
  BookingNotFoundError,
  BookingNotPayableError,
  CheckoutWindowClosedError,
  HoldExpiredError,
  PaymentEnvironmentMismatchError,
  PaymentProviderError,
  PaymentProviderOrderNotFoundError,
  PaymentStartInProgressError,
  SimulatorCapacityUnavailableError,
} from './payment-errors';
import { PhonePeConfigError } from './phonepe-config';
import { ProductionTesterNotAllowedError } from './production-access';
import { SandboxTesterNotAllowedError, SandboxTestersNotConfiguredError, type PaymentUserIdentity } from './sandbox-access';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The verified claims API Gateway's JWT authorizer attached, or null when there are none (the
 *  route was reached without one — the handler must answer 401 rather than trust anything else). */
export function readIdentity(event: {
  requestContext?: { authorizer?: { jwt?: { claims?: Record<string, unknown> } } };
}): PaymentUserIdentity | null {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    return null;
  }
  const email = typeof claims?.email === 'string' && claims.email.length > 0 ? claims.email : undefined;
  // API Gateway surfaces boolean claims as booleans or as the strings "true"/"false".
  const verified = claims?.email_verified;
  return { sub, email, emailVerified: verified === true || verified === 'true' };
}

/** Pulls `bookingId` out of a raw JSON body. Any other key in the body is never read. */
export function parseBookingIdFromBody(raw: string | undefined, isBase64Encoded = false): string | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const id = (parsed as Record<string, unknown>).bookingId;
  return typeof id === 'string' && UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** Only an https URL on a phonepe.com host may be handed to the browser as a checkout redirect. */
export function isSafeCheckoutRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && (url.hostname === 'phonepe.com' || url.hostname.endsWith('.phonepe.com'));
  } catch {
    return false;
  }
}

/** Maps a thrown error to a sanitized HTTP response, or null if it is not a known domain error
 *  (the caller then logs it and answers a generic 500). */
export function mapPaymentError(err: unknown): APIGatewayProxyStructuredResultV2 | null {
  if (
    err instanceof SandboxTestersNotConfiguredError ||
    err instanceof SandboxTesterNotAllowedError ||
    err instanceof ProductionTesterNotAllowedError
  ) {
    // Same body for all three: a caller must not learn whether an allowlist exists, which
    // environment's list it is, or who is on it.
    return errorResponse(403, 'payments_not_permitted', 'Payments are not available for this account');
  }
  if (err instanceof BookingNotFoundError) {
    return errorResponse(404, 'booking_not_found', 'Booking not found');
  }
  if (err instanceof BookingAlreadyPaidError) {
    return errorResponse(409, 'booking_already_paid', 'This booking has already been paid');
  }
  if (err instanceof BookingNotPayableError || err instanceof PaymentEnvironmentMismatchError) {
    // Environment mismatch answers exactly like any other unpayable booking — nothing about
    // environments is revealed to the caller.
    return errorResponse(409, 'booking_not_payable', 'This booking cannot be paid for');
  }
  if (err instanceof HoldExpiredError) {
    return errorResponse(409, 'hold_expired', 'The reservation hold has expired; please book again');
  }
  if (err instanceof SimulatorCapacityUnavailableError) {
    return errorResponse(409, 'capacity_unavailable', 'The selected slot is no longer available');
  }
  if (err instanceof CheckoutWindowClosedError) {
    return errorResponse(409, 'checkout_window_closed', 'Not enough time remains to complete a payment');
  }
  if (err instanceof PaymentStartInProgressError) {
    return errorResponse(409, 'payment_start_in_progress', 'A payment is already being started; retry shortly');
  }
  if (err instanceof PaymentProviderError) {
    return err.definiteRejection
      ? errorResponse(502, 'payment_provider_error', 'The payment provider could not process the request')
      : errorResponse(503, 'payment_provider_unavailable', 'The payment provider is temporarily unavailable');
  }
  if (err instanceof PaymentProviderOrderNotFoundError) {
    return errorResponse(502, 'payment_provider_error', 'The payment provider could not process the request');
  }
  if (err instanceof PhonePeConfigError) {
    return errorResponse(503, 'payments_unavailable', 'Payments are temporarily unavailable');
  }
  return null;
}
