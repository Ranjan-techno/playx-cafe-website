import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DefineAuthChallengeTriggerEvent } from 'aws-lambda';
import { MAX_FAILED_ATTEMPTS, handler } from './auth-define-challenge';

// Guest-first passwordless auth, Cognito CUSTOM_AUTH trigger 1 of 3 — see that handler's header.
// This trigger takes no AWS calls itself, so it's testable as a pure function of the event.

function makeEvent(
  session: DefineAuthChallengeTriggerEvent['request']['session'],
  userNotFound = false,
): DefineAuthChallengeTriggerEvent {
  return {
    version: '1',
    region: 'ap-south-1',
    userPoolId: 'ap-south-1_test',
    triggerSource: 'DefineAuthChallenge_Authentication',
    userName: 'guest@example.com',
    callerContext: { awsSdkVersion: 'test', clientId: 'test-client' },
    request: { userAttributes: { email: 'guest@example.com' }, session, userNotFound },
    response: { failAuthentication: false, issueTokens: false },
  };
}

test('first attempt: presents a CUSTOM_CHALLENGE, does not issue tokens', async () => {
  const event = makeEvent([]);
  const result = (await handler(event, {} as never, () => {})) as DefineAuthChallengeTriggerEvent;
  assert.equal(result.response.challengeName, 'CUSTOM_CHALLENGE');
  assert.equal(result.response.issueTokens, false);
  assert.equal(result.response.failAuthentication, false);
});

test('successful custom challenge: issues tokens without presenting another challenge', async () => {
  const event = makeEvent([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: true, challengeMetadata: 'PLAYX_EMAIL_OTP' }]);
  const result = (await handler(event, {} as never, () => {})) as DefineAuthChallengeTriggerEvent;
  assert.equal(result.response.issueTokens, true);
  assert.equal(result.response.failAuthentication, false);
});

test('incorrect OTP: re-presents CUSTOM_CHALLENGE while under the failed-attempt limit', async () => {
  const event = makeEvent([{ challengeName: 'CUSTOM_CHALLENGE', challengeResult: false, challengeMetadata: 'PLAYX_EMAIL_OTP' }]);
  const result = (await handler(event, {} as never, () => {})) as DefineAuthChallengeTriggerEvent;
  assert.equal(result.response.challengeName, 'CUSTOM_CHALLENGE');
  assert.equal(result.response.issueTokens, false);
  assert.equal(result.response.failAuthentication, false);
});

test('repeated failed attempts: fails authentication once the limit is reached', async () => {
  const session = Array.from({ length: MAX_FAILED_ATTEMPTS }, () => ({
    challengeName: 'CUSTOM_CHALLENGE' as const,
    challengeResult: false,
    challengeMetadata: 'PLAYX_EMAIL_OTP',
  }));
  const event = makeEvent(session);
  const result = (await handler(event, {} as never, () => {})) as DefineAuthChallengeTriggerEvent;
  assert.equal(result.response.issueTokens, false);
  assert.equal(result.response.failAuthentication, true);
});

test('fails closed if Cognito ever reports the user as not found', async () => {
  const event = makeEvent([], true);
  const result = (await handler(event, {} as never, () => {})) as DefineAuthChallengeTriggerEvent;
  assert.equal(result.response.issueTokens, false);
  assert.equal(result.response.failAuthentication, true);
});
