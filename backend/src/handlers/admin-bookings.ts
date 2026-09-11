import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { listAdminBookings, parseAdminBookingsQuery } from '../lib/admin-repository';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';

// Phase 3B: GET /admin/bookings — the list view behind PLAY X ADMIN's Bookings section.
//
// JWT-protected + requireAdmin (see lib/admin-auth.ts). Filters (date/status/search) and
// pagination (limit/cursor) are all parsed and validated by parseAdminBookingsQuery() before
// anything reaches SQL — see admin-repository.ts's header for why every value is parameterized and
// why `search` additionally has its ILIKE wildcard characters escaped.

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  const parsed = parseAdminBookingsQuery(event.queryStringParameters);
  if (!parsed.ok) {
    return errorResponse(400, parsed.error, parsed.message);
  }

  try {
    const db = await getDb();
    const page = await listAdminBookings(db, parsed.query);
    return jsonResponse(200, page);
  } catch (err) {
    resetDb();
    console.error('GET /admin/bookings failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load bookings');
  }
};
