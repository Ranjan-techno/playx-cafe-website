import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { describeForLog } from '../lib/log-redaction';
import { createWalkInBooking, parseWalkInBody } from '../lib/walk-in-booking';

// Stage 3A.1: POST /admin/bookings/walk-in — an admin records a customer booked and paid at the
// front desk. See lib/walk-in-booking.ts for the model, trust rules and the atomic
// booking -> allocation -> counter-payment transaction (shared inventory/allocation engine, always
// PRODUCTION occupancy, no email, never visible in any My Bookings).
//
// JWT-protected (the same Cognito authorizer as every /admin/* route) + authorizeAdmin(): a signed-in
// customer who isn't in the "admin" group gets 403 before the body is parsed or the DB touched. The
// verified admin sub is recorded as bookings.created_by_admin_sub.
//
// Logging: never the request body, customer details or payment reference — failures log only an
// error class/SQLSTATE summary (describeForLog).

export interface AdminWalkInDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  now: () => Date;
}

const defaultDeps: AdminWalkInDeps = { getDb, resetDb, now: () => new Date() };

export function createAdminWalkInBookingHandler(deps: AdminWalkInDeps = defaultDeps) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    const auth = authorizeAdmin(event);
    if (!auth.authorized) {
      return auth.response;
    }

    const parsed = parseWalkInBody(event.body);
    if (!parsed.ok) {
      return errorResponse(400, 'invalid_request', parsed.message);
    }

    try {
      const db = await deps.getDb();
      const result = await createWalkInBooking(db, parsed.value, auth.sub, deps.now());

      switch (result.outcome) {
        case 'created':
          return jsonResponse(201, result.booking);
        case 'product_error':
          return errorResponse(result.statusCode, result.error, result.message);
        case 'schedule_error':
          return errorResponse(400, result.error, result.message);
        case 'capacity_unavailable':
          return errorResponse(
            409,
            'capacity_unavailable',
            'No simulator is available for that Xperience at the requested time — choose another time',
          );
        default: {
          const exhaustive: never = result;
          throw new Error(`POST /admin/bookings/walk-in: unknown outcome ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      // createWalkInBooking has already rolled back its own transaction.
      deps.resetDb();
      console.error('POST /admin/bookings/walk-in failed', describeForLog(err));
      return errorResponse(500, 'internal_error', 'Failed to create walk-in booking');
    }
  };
}

export const handler = createAdminWalkInBookingHandler();
