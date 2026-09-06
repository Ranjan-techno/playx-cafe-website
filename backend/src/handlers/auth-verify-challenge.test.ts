import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { VerifyAuthChallengeResponseTriggerEvent } from 'aws-lambda';
import { handler } from './auth-verify-challenge';

// Guest-first passwordless auth, Cognito CUSTOM_AUTH trigger 3 of 3 — see that handler's header.
// This trigger takes no AWS calls itself, so it's testable as a pure function of the event.

function makeEvent(privateAnswer: string, challengeAnswer: string): VerifyAuthChallengeResponseTriggerEvent {
  return {
    version: '1',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_test',
    triggerSource: 'VerifyAuthChallengeResponse_Authentication',
    userName: 'guest@example.com',
    callerContext: { awsSdkVersion: 'test', clientId: 'test-client' },
    request: {
      userAttributes: { email: 'guest@example.com' },
      privateChallengeParameters: { answer: privateAnswer },
      challengeAnswer,
    },
    response: { answerCorrect: false },
  };
}

test('successful custom challenge: matching six-digit answer is accepted', async () => {
  const event = makeEvent('482308', '482308');
  const result = await handler(event, {} as never, () => {});
  assert.equal((result as VerifyAuthChallengeResponseTriggerEvent).response.answerCorrect, true);
});

test('incorrect OTP: non-matching answer is rejected', async () => {
  const event = makeEvent('482308', '999999');
  const result = await handler(event, {} as never, () => {});
  assert.equal((result as VerifyAuthChallengeResponseTriggerEvent).response.answerCorrect, false);
});

test('rejects when no code was ever generated for this challenge', async () => {
  const event = makeEvent('', '');
  const result = await handler(event, {} as never, () => {});
  assert.equal((result as VerifyAuthChallengeResponseTriggerEvent).response.answerCorrect, false);
});
