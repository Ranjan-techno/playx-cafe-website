import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { getSimulatorBoard } from '../lib/admin-repository';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { todayInIst } from '../lib/opening-hours';

// Phase 3B: GET /admin/simulators?date=YYYY-MM-DD — the read-only operational board behind PLAY X
// ADMIN's Simulators section: for S1/S2/M1/M2, every booking_allocations entry scheduled that IST
// day. No maintenance/edit controls exist here or anywhere in this phase (see this phase's brief,
// item 7) — this route only ever reads.
//
// JWT-protected + requireAdmin. `date` defaults to today (Asia/Kolkata) when omitted, same
// semantics as the dashboard.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  const dateParam = event.queryStringParameters?.date;
  let istDate: string;
  if (dateParam === undefined) {
    const today = todayInIst();
    istDate = `${today.year}-${pad(today.month)}-${pad(today.day)}`;
  } else if (DATE_RE.test(dateParam)) {
    istDate = dateParam;
  } else {
    return errorResponse(400, 'invalid_request', 'date must be YYYY-MM-DD');
  }

  try {
    const db = await getDb();
    const board = await getSimulatorBoard(db, istDate);
    return jsonResponse(200, { date: istDate, simulators: board });
  } catch (err) {
    resetDb();
    console.error('GET /admin/simulators failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load simulator board');
  }
};
