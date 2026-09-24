import { AdminGetUserCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoClient } from './cognito';
import { normalizeEmail } from './email';

// Stage 2F: recipient lookup for the booking-confirmation email sender
// (handlers/booking-confirmation-notify.ts — its only caller). Kept out of lib/cognito.ts so the
// auth Lambdas that import that module bundle exactly as before.

const COGNITO_SUB_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stage 2F: the verified email of the Cognito account `cognitoSub` (bookings.cognito_sub — the
 * owner the JWT authorizer proved at booking time), for the booking-confirmation email. The
 * webhook/reconciliation paths that confirm a booking have no browser token, so the recipient is
 * recovered server-side from this durable id — never from the booking form's free-text
 * customer_email and never from request or webhook data.
 *
 * Does NOT assume the sub is a valid AdminGetUser Username. This pool has UsernameAttributes =
 * ['email'] (constructs/auth.ts: signInAliases { email: true, username: false }) and every account
 * is created/looked up with Username = the email (auth-start.ts); AWS documents a sub as the
 * Username only for pools where username is not an alias attribute, which does not clearly cover
 * this configuration. Instead:
 *   1. ListUsers with Filter `sub = "<sub>"` — `sub` is a documented searchable standard attribute,
 *      independent of username configuration — must match exactly one account;
 *   2. AdminGetUser with the canonical Username Cognito itself returned (ListUsers is eventually
 *      consistent; AdminGetUser is AWS's recommended read of one user's current state);
 *   3. that account's `sub` must equal `cognitoSub`, it must be enabled, and email_verified must be
 *      "true" (a user who changes their email is unverified until they prove the new one).
 * ZERO matches -> 'not_found': ListUsers is eventually consistent, so the sender retries it with
 * its normal backoff instead of failing the notification. SEVERAL matches -> 'unavailable' (never
 * pick one arbitrarily). Disabled / different sub / unverified / UserNotFoundException ->
 * 'unavailable'. Any other error propagates (transient: the sender retries).
 */
export async function resolveVerifiedAccountEmail(
  cognitoSub: string,
  userPoolId: string | undefined = process.env.USER_POOL_ID,
): Promise<{ kind: 'verified'; recipient: { email: string } } | { kind: 'not_found' } | { kind: 'unavailable' }> {
  if (!userPoolId) {
    throw new Error('USER_POOL_ID env var not configured');
  }
  // bookings.cognito_sub always is a UUID; anything else never reaches a filter string.
  if (!COGNITO_SUB_RE.test(cognitoSub)) {
    return { kind: 'unavailable' };
  }
  const client = getCognitoClient();
  const listed = await client.send(
    new ListUsersCommand({ UserPoolId: userPoolId, Filter: `sub = "${cognitoSub}"`, Limit: 2 }),
  );
  const matches = listed.Users ?? [];
  if (matches.length === 0) {
    return { kind: 'not_found' };
  }
  const username = matches[0]?.Username;
  if (matches.length !== 1 || !username) {
    return { kind: 'unavailable' };
  }

  let attributes: { Name?: string; Value?: string }[];
  try {
    const user = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
    if (user.Enabled === false) {
      return { kind: 'unavailable' };
    }
    attributes = user.UserAttributes ?? [];
  } catch (err) {
    if (err instanceof Error && err.name === 'UserNotFoundException') {
      return { kind: 'unavailable' };
    }
    throw err;
  }
  const attr = (name: string) => attributes.find((a) => a.Name === name)?.Value;
  if (attr('sub') !== cognitoSub) {
    return { kind: 'unavailable' };
  }
  const email = normalizeEmail(attr('email'));
  if (!email || attr('email_verified') !== 'true') {
    return { kind: 'unavailable' };
  }
  return { kind: 'verified', recipient: { email } };
}
