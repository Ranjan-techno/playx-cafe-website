import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { assertAppEnvironment, environmentMatchSql, type AppEnvironment } from '../lib/environment';
import { errorResponse, jsonResponse } from '../lib/http';
import { toIstDateTimeParts } from '../lib/opening-hours';

// Story 2.6: GET /bookings/me — lists bookings for the authenticated Cognito user only.
//
// Requires the Cognito JWT authorizer (see infra/lib/constructs/api.ts). Scoped strictly to the
// caller's own verified "sub" claim — there is no user id accepted anywhere in this request to
// trust or mistrust; the WHERE clause below is the only source of the identity it filters on.
//
// Stage 2E: environment-isolated. Each deployed route lists exactly ONE booking_environment, fixed
// when its handler is built (createListMyBookingsHandler below), never read from the request:
//   GET /bookings/me             SANDBOX     (this file's `handler` — staging/local)
//   GET /bookings/production/me  PRODUCTION  (list-my-bookings-production.ts — playxcafe.com)
// so a production page can never be handed a sandbox booking (whose status it would then look up
// on the PRODUCTION status route and fail to find), and vice versa. No query parameter, header,
// Origin or hostname is consulted.

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

export interface ListMyBookingsDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
}

const defaultDeps: ListMyBookingsDeps = { getDb, resetDb };

/** The owner- AND environment-scoped query. `environment` is a server-side literal; an unknown
 *  value throws before any SQL runs. NULL/unknown stored environments match nothing. */
export async function listBookingsForOwner(db: DbClient, sub: string, environment: AppEnvironment): Promise<BookingRow[]> {
  const env = assertAppEnvironment(environment, 'environment');
  const { rows } = await db.query<BookingRow>(
    `SELECT b.id, b.booking_number, p.product_code, b.price_inr, b.scheduled_start_at, b.status, b.notes, b.created_at
     FROM bookings b
     JOIN products p ON p.id = b.product_id
     WHERE b.cognito_sub = $1
       AND ${environmentMatchSql('b.booking_environment', '$2', env)}
     ORDER BY b.scheduled_start_at DESC`,
    [sub, env],
  );
  return rows;
}

/** Builds the GET handler for one hard-coded environment (validated at cold start). */
export function createListMyBookingsHandler(bookingEnvironment: AppEnvironment, deps: ListMyBookingsDeps = defaultDeps) {
  const environment = assertAppEnvironment(bookingEnvironment, 'bookingEnvironment');
  const logLabel = environment === 'PRODUCTION' ? 'GET /bookings/production/me' : 'GET /bookings/me';

  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    const sub = event.requestContext.authorizer.jwt.claims.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      // Defensive only: API Gateway's JWT authorizer should never let a request through without a
      // "sub" claim, since every Cognito-issued token carries one.
      return errorResponse(401, 'unauthenticated', 'Missing subject claim');
    }

    try {
      const db = await deps.getDb();
      const rows = await listBookingsForOwner(db, sub, environment);

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
      deps.resetDb();
      console.error(`${logLabel} failed`, err);
      return errorResponse(500, 'internal_error', 'Failed to load bookings');
    }
  };
}

// GET /bookings/me — SANDBOX bookings only (staging.playxcafe.com, local development).
export const handler = createListMyBookingsHandler('SANDBOX');
