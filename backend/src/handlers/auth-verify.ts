import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  AdminRespondToAuthChallengeCommand,
  AdminUpdateUserAttributesCommand,
  CodeMismatchException,
  ExpiredCodeException,
  LimitExceededException,
  NotAuthorizedException,
  TooManyRequestsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoClient } from '../lib/cognito';
import { errorResponse, jsonResponse } from '../lib/http';
import { normalizeEmail } from '../lib/email';
import { OTP_CODE_RE } from '../lib/otp';

// Guest-first passwordless auth, step 2 of 2 — completes the CUSTOM_CHALLENGE Cognito CUSTOM_AUTH
// flow auth-start.ts started, by answering Play X's own six-digit-OTP challenge (see the
// CreateAuthChallenge/DefineAuthChallenge/VerifyAuthChallengeResponse triggers in this same
// directory, and lib/otp.ts for why this isn't Cognito's native EMAIL_OTP first factor). See
// auth-start.ts's header for the verification-semantics explanation this continues.

const SESSION_MAX_LENGTH = 4096;

interface VerifyBody {
  email: string;
  code: string;
  session: string;
}

function parseBody(raw: string | undefined): VerifyBody | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const body = parsed as Record<string, unknown>;

  const email = normalizeEmail(body.email);
  if (!email) {
    return null;
  }

  const code = body.code;
  if (typeof code !== 'string' || !OTP_CODE_RE.test(code)) {
    return null;
  }

  const session = body.session;
  if (typeof session !== 'string' || session.length === 0 || session.length > SESSION_MAX_LENGTH) {
    return null;
  }

  return { email, code, session };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = parseBody(event.body);
  if (!body) {
    return errorResponse(400, 'invalid_request', 'Expected { email: string, code: "123456", session: string }');
  }

  const userPoolId = process.env.USER_POOL_ID;
  const clientId = process.env.WEB_CLIENT_ID;
  if (!userPoolId || !clientId) {
    console.error('POST /auth/verify missing USER_POOL_ID/WEB_CLIENT_ID env vars');
    return errorResponse(500, 'temporary_error', 'Unable to complete sign-in right now.');
  }

  const client = getCognitoClient();

  try {
    const result = await client.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        ChallengeName: 'CUSTOM_CHALLENGE',
        ChallengeResponses: {
          USERNAME: body.email,
          ANSWER: body.code,
        },
        Session: body.session,
      }),
    );

    const tokens = result.AuthenticationResult;
    if (!tokens?.IdToken || !tokens.AccessToken || !tokens.RefreshToken) {
      // Unlike a native EMAIL_OTP/SMS_MFA challenge, Cognito doesn't throw CodeMismatchException
      // for a wrong CUSTOM_CHALLENGE answer — auth-define-challenge.ts decided to re-present the
      // challenge instead (a wrong-but-not-yet-locked-out attempt: auth-create-challenge.ts has
      // already emailed a fresh code), so this comes back as a normal response carrying a new
      // ChallengeName/Session rather than an error. Cognito rotates Session on every attempt, so
      // the client must retry with this one — resubmitting the one it just used, or starting
      // over via /auth/start, would both be rejected.
      if (result.ChallengeName === 'CUSTOM_CHALLENGE' && result.Session) {
        return jsonResponse(400, {
          error: 'invalid_code',
          message: 'The code you entered is incorrect. Check your email for a new code and try again.',
          session: result.Session,
        });
      }

      // Defensive only: no other challenge should ever be pending here (see
      // auth-define-challenge.ts — it only ever issues tokens, re-presents CUSTOM_CHALLENGE, or
      // fails outright, which Cognito instead surfaces as NotAuthorizedException below).
      console.error('POST /auth/verify unexpected result', result.ChallengeName ?? 'no_challenge_name');
      return errorResponse(500, 'temporary_error', 'Unable to complete sign-in right now.');
    }

    // Best-effort only: mark the email verified now that its owner has proven receipt of the
    // OTP, mirroring what Cognito's native EMAIL_OTP first factor used to do automatically as a
    // side effect (see auth-start.ts's header) — CUSTOM_AUTH has no equivalent built-in behavior,
    // so this flow does it explicitly instead. Tokens are already issued at this point, so a
    // failure here (e.g. this Lambda momentarily lacking the permission) must never fail sign-in
    // itself; it just leaves email_verified for next time.
    try {
      await client.send(
        new AdminUpdateUserAttributesCommand({
          UserPoolId: userPoolId,
          Username: body.email,
          UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
        }),
      );
    } catch (err) {
      console.error(
        'POST /auth/verify failed to mark email verified',
        err instanceof Error ? err.name : 'unknown_error',
      );
    }

    return jsonResponse(200, {
      idToken: tokens.IdToken,
      accessToken: tokens.AccessToken,
      refreshToken: tokens.RefreshToken,
      expiresIn: tokens.ExpiresIn,
    });
  } catch (err) {
    console.error('POST /auth/verify failed', err instanceof Error ? err.name : 'unknown_error');

    // CodeMismatchException/ExpiredCodeException are specific to Cognito's native challenge
    // types (EMAIL_OTP, SMS_MFA, ...) and shouldn't fire for CUSTOM_CHALLENGE — a wrong-but-not-
    // yet-locked-out answer instead comes back as a normal response with a new Session, handled
    // above. Kept here only as a defensive fallback.
    if (err instanceof CodeMismatchException) {
      return errorResponse(400, 'invalid_code', 'The code you entered is incorrect.');
    }
    if (err instanceof ExpiredCodeException) {
      return errorResponse(400, 'expired_code', 'That code has expired. Request a new one.');
    }
    if (err instanceof NotAuthorizedException) {
      // Cognito's exception for a stale/invalid Session token, AND what it throws when
      // auth-define-challenge.ts sets failAuthentication=true (too many wrong attempts) — both
      // mean this attempt is dead and a fresh /auth/start is required, so the same generic
      // message covers both without revealing which happened.
      return errorResponse(400, 'expired_session', 'This sign-in attempt has expired. Start again.');
    }
    if (err instanceof TooManyRequestsException || err instanceof LimitExceededException) {
      return errorResponse(429, 'rate_limited', 'Too many attempts. Try again shortly.');
    }
    return errorResponse(500, 'temporary_error', 'Unable to complete sign-in right now.');
  }
};
