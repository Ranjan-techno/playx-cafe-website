import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { authorizeAdmin } from '../lib/admin-auth';
import { listAdminPayments, parseAdminPaymentsQuery } from '../lib/admin-repository';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';

// Phase 3B: GET /admin/payments — payment visibility behind PLAY X ADMIN's Payments section.
//
// JWT-protected + requireAdmin. Read-only and deliberately limited to visibility, per this phase's
// brief (item 9): there is no route anywhere in this phase that can mark a payment PAID, and this
// handler never returns payments.metadata (the raw provider payload) or any provider
// credential/secret — see admin-repository.ts's mapAdminPaymentListRow().

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const auth = authorizeAdmin(event);
  if (!auth.authorized) {
    return auth.response;
  }

  const parsed = parseAdminPaymentsQuery(event.queryStringParameters);
  if (!parsed.ok) {
    return errorResponse(400, parsed.error, parsed.message);
  }

  try {
    const db = await getDb();
    const page = await listAdminPayments(db, parsed.query);
    return jsonResponse(200, page);
  } catch (err) {
    resetDb();
    console.error('GET /admin/payments failed', err);
    return errorResponse(500, 'internal_error', 'Failed to load payments');
  }
};
