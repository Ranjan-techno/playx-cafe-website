import type { CreateAuthChallengeTriggerHandler } from 'aws-lambda';
import { generateOtp } from '../lib/otp';
import { sendOtpEmail } from '../lib/ses';

// Guest-first passwordless auth, Cognito CUSTOM_AUTH trigger 2 of 3 — generates the six-digit
// code Play X controls (see lib/otp.ts for why this exists instead of Cognito's native EMAIL_OTP
// first factor) and emails it via SES.
//
// The generated code goes ONLY into `privateChallengeParameters`: Cognito hands that back to
// auth-verify-challenge.ts (trigger 3) and never to the client. `publicChallengeParameters` and
// `challengeMetadata`, by contrast, ARE both returned to the client (via the InitiateAuth/
// RespondToAuthChallenge responses auth-start.ts/auth-verify.ts forward), so neither may ever
// carry the code or anything else secret.
//
// Runs again on every retry — auth-define-challenge.ts re-presents CUSTOM_CHALLENGE after a wrong
// answer (up to its failed-attempt limit), and each re-presentation calls this trigger again, so
// every attempt gets a fresh code and a fresh email rather than one code being retryable forever.

export const handler: CreateAuthChallengeTriggerHandler = async (event) => {
  const email = event.request.userAttributes.email ?? event.userName;
  const code = generateOtp();

  // Never log `code`, here or anywhere downstream — see the file header.
  await sendOtpEmail(email, code);

  event.response.publicChallengeParameters = {};
  event.response.privateChallengeParameters = { answer: code };
  // Returned to the client as-is (see file header) — always this fixed, generic label, never the
  // code itself.
  event.response.challengeMetadata = 'PLAYX_EMAIL_OTP';

  return event;
};
