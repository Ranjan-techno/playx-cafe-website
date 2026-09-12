import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { toIstDateTimeParts } from '../lib/opening-hours';

// Story 2.6: GET /bookings/me — lists bookings for the authenticated Cognito user only.
//
// Requires the Cognito JWT authorizer (see infra/lib/constructs/api.ts). Scoped strictly to the
// caller's own verified "sub" claim — there is no user id accepted anywhere in this request to
// trust or mistrust; the WHERE clause below is the only source of the identity it filters on.

interface BookingRow {
  id: string;
  booking_number: number;
  product_code: string;
  price_inr: string; // pg returns NUMERIC as a string
  scheduled_start_at: Date;
  status: string;
  notes: string | null;
  created_at: Date;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    // Defensive only: API Gateway's JWT authorizer should never let a request through without a
    // "sub" claim, since every Cognito-issued token carries one.
    return errorResponse(401, 'unauthenticated', 'Missing subject claim');
  }

  try {
    const db = await getDb();
    const { rows } = await db.query<BookingRow>(
      `SELECT b.id, b.booking_number, p.product_code, b.price_inr, b.scheduled_start_at, b.status, b.notes, b.created_at
       FROM bookings b
       JOIN products p ON p.id = b.product_id
       WHERE b.cognito_sub = $1
       ORDER BY b.scheduled_start_at DESC`,
      [sub],
    );

    const bookings = rows.map((row) => {
      const { date, time } = toIstDateTimeParts(row.scheduled_start_at);
      return {
        id: row.id,
        // Additive field: the 4-digit customer-facing reference (see this repo's CLAUDE.md and
        // database/migrations/004_short_booking_number.sql). `id` is unchanged — existing clients
        // that only read id/product/price/date/time/status/notes/createdAt are unaffected.
        bookingNumber: row.booking_number,
        product: row.product_code,
        price: Number(row.price_inr),
        date,
        time,
        status: row.status,
        notes: row.notes,
        createdAt: row.created_at.toISOString(),
      };
    });

    return jsonResponse(200, { bookings });
  } catch (err) {
    resetDb();
    console.error('GET /bookings/me failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load bookings');
  }
};
