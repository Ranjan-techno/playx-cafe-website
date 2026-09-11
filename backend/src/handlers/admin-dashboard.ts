import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { getDashboardSummary } from '../lib/admin-repository';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { todayInIst } from '../lib/opening-hours';

// Phase 3B: GET /admin/dashboard — an operational summary for PLAY X ADMIN's Dashboard section.
//
// JWT-protected (see infra/lib/constructs/api.ts) + requireAdmin (see lib/admin-auth.ts) — defense
// in depth, per this phase's brief: a normal authenticated customer gets 403 here, never a
// dashboard. "Today" always means the current Asia/Kolkata business date (todayInIst(), same
// helper create-booking.ts/availability.ts already use for schedule validation) — never the Lambda
// runtime's UTC clock or any date a caller could supply, since nothing in the query string is read
// here at all.

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  try {
    const db = await getDb();
    const today = todayInIst();
    const istDate = `${today.year}-${pad(today.month)}-${pad(today.day)}`;

    const summary = await getDashboardSummary(db, istDate);
    return jsonResponse(200, summary);
  } catch (err) {
    resetDb();
    console.error('GET /admin/dashboard failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load dashboard summary');
  }
};
