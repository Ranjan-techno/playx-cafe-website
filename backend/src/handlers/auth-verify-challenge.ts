import type { VerifyAuthChallengeResponseTriggerHandler } from 'aws-lambda';

// Guest-first passwordless auth, Cognito CUSTOM_AUTH trigger 3 of 3 — compares the code the
// customer submitted (event.request.challengeAnswer, forwarded here from auth-verify.ts's
// AdminRespondToAuthChallenge ANSWER) against the one auth-create-challenge.ts generated
// (event.request.privateChallengeParameters.answer, never exposed to the client — see that
// file's header). Never logs either value.
//
// auth-verify.ts already rejects anything not matching lib/otp.ts's OTP_CODE_RE
// (exactly six digits) before Cognito ever sees it, so this only has to check equality.

export const handler: VerifyAuthChallengeResponseTriggerHandler = async (event) => {
  const expected = event.request.privateChallengeParameters.answer;
  const submitted = event.request.challengeAnswer;

  event.response.answerCorrect = typeof expected === 'string' && expected.length > 0 && expected === submitted;

  return event;
};
