import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { isValidUuid, transitionBookingStatus } from '../lib/admin-repository';
import { BOOKING_STATUSES, isValidBookingStatus, type BookingStatus } from '../lib/booking-status';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';

// Phase 3B: PATCH /admin/bookings/{id}/status — the one admin write route this phase adds. See
// lib/booking-status.ts for the whitelist of transitions this accepts (only statuses that already
// exist in booking_status — see that file's header for why 'checked_in' isn't one of them yet) and
// admin-repository.ts's transitionBookingStatus() for the transactional lock/validate/update.
//
// JWT-protected + requireAdmin. The target status is the *only* thing this endpoint ever writes to
// bookings.status — never free text, and never anything derived from a payment. This route cannot
// mark a payment PAID (see lib/confirm-successful-payment.ts, the only writer of that) — payment
// state stays entirely separate, per this phase's brief, item 9.

interface StatusBody {
  status: BookingStatus;
}

function parseBody(raw: string | undefined): StatusBody | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const status = (parsed as Record<string, unknown>).status;
  if (!isValidBookingStatus(status)) {
    return null;
  }
  return { status };
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  const bookingId = event.pathParameters?.id;
  if (typeof bookingId !== 'string' || !isValidUuid(bookingId)) {
    return errorResponse(404, 'booking_not_found', 'No booking with that id');
  }

  const body = parseBody(event.body);
  if (!body) {
    return errorResponse(400, 'invalid_request', `Expected { status: one of ${BOOKING_STATUSES.join(', ')} }`);
  }

  try {
    const db = await getDb();
    const result = await transitionBookingStatus(db, bookingId, body.status);

    switch (result.outcome) {
      case 'not_found':
        return errorResponse(404, 'booking_not_found', 'No booking with that id');
      case 'invalid_transition':
        return errorResponse(
          409,
          'invalid_status_transition',
          `Booking is "${result.from}" and cannot transition to "${result.to}"`,
        );
      case 'ok':
        return jsonResponse(200, { id: result.id, status: result.status });
      default: {
        // Exhaustiveness guard — TransitionBookingStatusResult is a closed union, so this is
        // unreachable at compile time; kept only as a defensive runtime fallback, same pattern as
        // sync-payment-status.ts's applyProviderOutcome().
        const exhaustive: never = result;
        throw new Error(`PATCH /admin/bookings/{id}/status: unknown outcome ${JSON.stringify(exhaustive)}`);
      }
    }
  } catch (err) {
    resetDb();
    console.error('PATCH /admin/bookings/{id}/status failed', err);
    return errorResponse(500, 'internal_error', 'Failed to update booking status');
  }
};
