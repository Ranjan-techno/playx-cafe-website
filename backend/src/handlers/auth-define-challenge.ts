import type { DefineAuthChallengeTriggerHandler } from 'aws-lambda';

// Guest-first passwordless auth, Cognito CUSTOM_AUTH trigger 1 of 3 — decides, after every step,
// whether to present another CUSTOM_CHALLENGE, issue tokens, or fail the sign-in outright. Runs
// entirely inside Cognito's own authentication session (`event.request.session`, one entry per
// challenge already presented/answered this sign-in attempt); it only ever sees whether past
// attempts succeeded or failed, never the code itself — that lives only in
// auth-create-challenge.ts's/auth-verify-challenge.ts's private challenge parameters.
//
// See auth-create-challenge.ts (trigger 2, generates+emails the code) and
// auth-verify-challenge.ts (trigger 3, checks a submitted answer) for the rest of this flow, and
// auth-start.ts/auth-verify.ts for the public API routes that drive it via
// AdminInitiateAuth/AdminRespondToAuthChallenge.

// Practical anti-abuse limit: after this many wrong-code attempts in one sign-in session, fail
// outright rather than presenting yet another challenge. Cognito's own auth-session validity
// (see constructs/auth.ts's authSessionValidity) separately bounds how long that session token
// can be replayed against at all.
export const MAX_FAILED_ATTEMPTS = 5;

export const handler: DefineAuthChallengeTriggerHandler = async (event) => {
  const { session, userNotFound } = event.request;

  // Defensive only: auth-start.ts's AdminInitiateAuth always targets a user it just confirmed
  // exists (creating one first if needed), so Cognito shouldn't reach this trigger with
  // userNotFound set. If it ever does, fail closed rather than issuing a challenge for an
  // account that isn't there.
  if (userNotFound) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  const lastAttempt = session.length > 0 ? session[session.length - 1] : undefined;
  if (lastAttempt?.challengeResult === true) {
    // CUSTOM_CHALLENGE is this flow's only step, so a successful answer completes sign-in.
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
    return event;
  }

  const failedAttempts = session.filter((attempt) => attempt.challengeResult === false).length;
  if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
    return event;
  }

  event.response.issueTokens = false;
  event.response.failAuthentication = false;
  event.response.challengeName = 'CUSTOM_CHALLENGE';
  return event;
};
