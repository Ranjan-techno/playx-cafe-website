import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { getAdminBookingDetail, isValidUuid } from '../lib/admin-repository';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';

// Phase 3B: GET /admin/bookings/{id} — full operational detail for one booking (customer contact
// snapshot, product, schedule, allocations, payment attempts) behind PLAY X ADMIN's Bookings
// section.
//
// JWT-protected + requireAdmin. Returns 404 for both a malformed id (never a real booking) and a
// well-formed but unknown one — a caller can't distinguish "not a UUID" from "no such booking",
// which avoids leaking which UUIDs happen to look plausible. Never returns payments.metadata (the
// raw provider payload) or any Cognito-internal field — see admin-repository.ts's
// getAdminBookingDetail()/buildAdminBookingDetail().

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  const bookingId = event.pathParameters?.id;
  if (typeof bookingId !== 'string' || !isValidUuid(bookingId)) {
    return errorResponse(404, 'booking_not_found', 'No booking with that id');
  }

  try {
    const db = await getDb();
    const detail = await getAdminBookingDetail(db, bookingId);
    if (!detail) {
      return errorResponse(404, 'booking_not_found', 'No booking with that id');
    }
    return jsonResponse(200, detail);
  } catch (err) {
    resetDb();
    console.error('GET /admin/bookings/{id} failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load booking detail');
  }
};
