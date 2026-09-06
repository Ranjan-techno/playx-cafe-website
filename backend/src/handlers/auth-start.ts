import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminInitiateAuthCommand,
  LimitExceededException,
  TooManyRequestsException,
  UserNotFoundException,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoClient } from '../lib/cognito';
import { errorResponse, jsonResponse } from '../lib/http';
import { normalizeEmail } from '../lib/email';
import { normalizeIndianPhone } from '../lib/phone';

// Guest-first passwordless auth, step 1 of 2 (see auth-verify.ts for step 2).
//
// This is the ONLY place a Play X customer account gets created without a password. A brand-new
// user is created via AdminCreateUser with an unverified email and no password at all — never
// with email_verified forced to true, which would be verification theater rather than the real
// thing. Sending the OTP IS the verification channel: once the customer proves receipt of it in
// auth-verify.ts, that handler explicitly marks the email verified as a side effect (Cognito's
// own CUSTOM_AUTH flow, unlike its native EMAIL_OTP first factor, has no built-in concept of what
// a custom challenge proved, so it doesn't do this automatically — see that file). Because the
// User Pool has EMAIL_OTP enabled as an alternative first factor, AdminCreateUser with no
// TemporaryPassword does NOT necessarily leave this account in FORCE_CHANGE_PASSWORD — and even
// if it did, that status only gates password-based sign-in (NEW_PASSWORD_REQUIRED), which this
// account never goes through, since it only ever authenticates via CUSTOM_AUTH.
//
// CUSTOM_AUTH drives Play X's own six-digit-OTP challenge (see the CreateAuthChallenge/
// DefineAuthChallenge/VerifyAuthChallengeResponse triggers in this same handlers/ directory)
// rather than Cognito's native EMAIL_OTP first factor, which generates eight-digit codes Play X
// can't control — see lib/otp.ts.
//
// An existing user (created earlier through the password signup flow) skips straight to
// AdminInitiateAuth. Both paths return the same generic { challenge, session } shape so the
// response never reveals whether the account was new or pre-existing.

const NAME_MAX_LENGTH = 100;

interface StartBody {
  email: string;
  name: string;
  phone: string;
}

function parseBody(raw: string | undefined): StartBody | null {
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

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    return null;
  }

  const phone = normalizeIndianPhone(body.phone);
  if (!phone) {
    return null;
  }

  return { email, name, phone };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const body = parseBody(event.body);
  if (!body) {
    return errorResponse(
      400,
      'invalid_request',
      'Expected { email: string, name: string, phone: "10-digit Indian mobile number" }',
    );
  }

  const userPoolId = process.env.USER_POOL_ID;
  const clientId = process.env.WEB_CLIENT_ID;
  if (!userPoolId || !clientId) {
    console.error('POST /auth/start missing USER_POOL_ID/WEB_CLIENT_ID env vars');
    return errorResponse(500, 'temporary_error', 'Unable to start sign-in right now.');
  }

  const client = getCognitoClient();

  try {
    let userExists = true;
    try {
      await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: body.email }));
    } catch (err) {
      if (err instanceof UserNotFoundException) {
        userExists = false;
      } else {
        throw err;
      }
    }

    if (!userExists) {
      try {
        await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: body.email,
            // No TemporaryPassword, no password ever set for this account — see the file
            // header. SUPPRESS skips Cognito's default "here is your temporary password"
            // invitation email/SMS, which doesn't apply to a passwordless account anyway.
            MessageAction: 'SUPPRESS',
            UserAttributes: [
              { Name: 'email', Value: body.email },
              { Name: 'name', Value: body.name },
              { Name: 'phone_number', Value: body.phone },
            ],
          }),
        );
      } catch (err) {
        if (!(err instanceof UsernameExistsException)) {
          throw err;
        }
        // Lost a race with a concurrent /auth/start call for the same email — the user now
        // exists either way, so fall through and authenticate against it.
      }
    }

    const initiateResult = await client.send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId,
        ClientId: clientId,
        AuthFlow: 'CUSTOM_AUTH',
        AuthParameters: {
          USERNAME: body.email,
          CHALLENGE_NAME: 'CUSTOM_CHALLENGE',
        },
      }),
    );

    if (initiateResult.ChallengeName !== 'CUSTOM_CHALLENGE' || !initiateResult.Session) {
      console.error('POST /auth/start unexpected challenge', initiateResult.ChallengeName);
      return errorResponse(500, 'temporary_error', 'Unable to start sign-in right now.');
    }

    return jsonResponse(200, { challenge: 'CUSTOM_CHALLENGE', session: initiateResult.Session });
  } catch (err) {
    console.error('POST /auth/start failed', err instanceof Error ? err.name : 'unknown_error');
    if (err instanceof TooManyRequestsException || err instanceof LimitExceededException) {
      return errorResponse(429, 'rate_limited', 'Too many attempts. Try again shortly.');
    }
    return errorResponse(500, 'temporary_error', 'Unable to start sign-in right now.');
  }
};
