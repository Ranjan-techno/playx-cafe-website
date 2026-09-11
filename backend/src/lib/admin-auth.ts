// Phase 3B: PLAY X ADMIN authorization — the one place every /admin/* handler asks "is this
// caller allowed to be here?". Reuses the existing Cognito User Pool and its JWT authorizer (see
// infra/lib/constructs/api.ts) rather than a second auth system: API Gateway has already verified
// the token's signature/issuer/audience by the time a handler runs, exactly as it does for
// /bookings* — the only new check here is *authorization* (which verified user, if any, is an
// admin), never authentication itself.
//
// requireAdmin() never trusts a query parameter, request body, or "isAdmin" flag the browser might
// send — the only input it reads is event.requestContext.authorizer.jwt.claims, the claim map API
// Gateway itself attached after validating the JWT. Defense in depth: the CDK-level JWT authorizer
// (see api.ts) is what stops a request with no/invalid token before a Lambda even runs; this
// function is the second, independent layer that stops a validly-authenticated *non-admin*
// customer, which the authorizer alone cannot do (HttpUserPoolAuthorizer has no concept of group
// membership).

import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { errorResponse } from './http';

/** The one Cognito group that grants access to every /admin/* route. */
export const ADMIN_GROUP = 'admin';

export class AdminAuthorizationError extends Error {
  constructor(
    public readonly statusCode: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalizes the `cognito:groups` claim into a plain string[], tolerant of every shape it can
 * actually arrive in on event.requestContext.authorizer.jwt.claims:
 *   - a real string[] (aws-lambda's own JWT authorizer type — the JWT's native shape for a list
 *     claim, and what a hand-built test event naturally uses);
 *   - a single string, e.g. "admin" (one group, no list wrapper);
 *   - a comma-joined string, e.g. "admin,staff";
 *   - a bracketed string, e.g. "[admin, staff]" — API Gateway's HTTP API JWT authorizer is known
 *     to flatten a multi-valued claim into this literal `[a, b]` text form when it injects claims
 *     into the request context, rather than preserving a JSON array.
 * Never throws: any other shape (missing, null, a number, ...) safely yields [].
 */
export function parseCognitoGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) {
    return claim.filter((group): group is string => typeof group === 'string' && group.length > 0);
  }
  if (typeof claim !== 'string') {
    return [];
  }
  const withoutBrackets = claim.trim().replace(/^\[/, '').replace(/\]$/, '');
  return withoutBrackets
    .split(',')
    .map((group) => group.trim())
    .filter((group) => group.length > 0);
}

/**
 * Verifies the caller's already-validated JWT (see this file's header) carries `cognito:groups`
 * containing "admin". Returns the verified `sub` on success; throws AdminAuthorizationError
 * otherwise — 401 if the request somehow reached this handler with no valid authorizer context at
 * all (defensive only: the CDK-level JWT authorizer should never let that through), 403 for a
 * genuinely authenticated customer who simply isn't an admin.
 */
export function requireAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): string {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new AdminAuthorizationError(401, 'Missing subject claim');
  }

  const groups = parseCognitoGroups(claims['cognito:groups']);
  if (!groups.includes(ADMIN_GROUP)) {
    throw new AdminAuthorizationError(403, 'Admin group membership required');
  }

  return sub;
}

export type AdminAuthResult =
  | { authorized: true; sub: string }
  | { authorized: false; response: APIGatewayProxyStructuredResultV2 };

/**
 * Handler-friendly wrapper around requireAdmin(): every /admin/* handler starts with
 *
 *   const auth = authorizeAdmin(event);
 *   if (!auth.authorized) return auth.response;
 *
 * instead of repeating the same try/catch six times.
 */
export function authorizeAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): AdminAuthResult {
  try {
    return { authorized: true, sub: requireAdmin(event) };
  } catch (err) {
    if (err instanceof AdminAuthorizationError) {
      const code = err.statusCode === 401 ? 'unauthenticated' : 'forbidden';
      return { authorized: false, response: errorResponse(err.statusCode, code, err.message) };
    }
    throw err;
  }
}
