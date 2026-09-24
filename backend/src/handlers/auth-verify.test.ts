import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { NotAuthorizedException } from '@aws-sdk/client-cognito-identity-provider';
import { getCognitoClient } from '../lib/cognito';
import { handler } from './auth-verify';

// POST /auth/verify: email_verified=true is set ONLY after Cognito issued tokens for a correct OTP,
// and (Stage 2F) it is required — sign-in does not return tokens unless it was recorded.

const TOKENS = { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh', ExpiresIn: 3600 };
let calls: { command: string; input: any }[] = [];
let respond: () => any;
let updateFailures: number;

beforeEach(() => {
  process.env.USER_POOL_ID = 'pool-1';
  process.env.WEB_CLIENT_ID = 'client-1';
  calls = [];
  updateFailures = 0;
  respond = () => ({ AuthenticationResult: TOKENS });
  (getCognitoClient() as any).send = async (cmd: any) => {
    const command = cmd.constructor.name;
    calls.push({ command, input: cmd.input });
    if (command === 'AdminRespondToAuthChallengeCommand') return respond();
    if (command === 'AdminUpdateUserAttributesCommand') {
      if (updateFailures > 0) {
        updateFailures -= 1;
        throw Object.assign(new Error('x'), { name: 'TooManyRequestsException' });
      }
      return {};
    }
    throw new Error(`unexpected ${command}`);
  };
});

const event = (code = '123456') =>
  ({ body: JSON.stringify({ email: 'Racer@Example.com', code, session: 'sess-1' }) }) as unknown as APIGatewayProxyEventV2;
const call = async (code?: string) => (await handler(event(code), {} as never, () => {})) as APIGatewayProxyStructuredResultV2;
const updates = () => calls.filter((c) => c.command === 'AdminUpdateUserAttributesCommand');

test('correct OTP: email_verified=true is set for that account, AFTER the challenge succeeded, then tokens are returned', async () => {
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body as string).accessToken, 'access');
  assert.deepEqual(calls.map((c) => c.command), ['AdminRespondToAuthChallengeCommand', 'AdminUpdateUserAttributesCommand']);
  assert.deepEqual(updates()[0].input, {
    UserPoolId: 'pool-1',
    Username: 'racer@example.com',
    UserAttributes: [{ Name: 'email_verified', Value: 'true' }],
  });
});

test('wrong OTP (challenge re-presented): never marks the email verified, no tokens', async () => {
  respond = () => ({ ChallengeName: 'CUSTOM_CHALLENGE', Session: 'sess-2' });
  const res = await call('000000');
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body as string).error, 'invalid_code');
  assert.equal(updates().length, 0);
});

test('failed/expired/locked-out attempt (NotAuthorizedException): never marks the email verified', async () => {
  respond = () => {
    throw new NotAuthorizedException({ message: 'no', $metadata: {} });
  };
  const res = await call();
  assert.equal(res.statusCode, 400);
  assert.equal(updates().length, 0);
});

test('malformed code: rejected before Cognito, never marks verified', async () => {
  const res = await call('12ab');
  assert.equal(res.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('a transient failure marking verified is retried; sign-in succeeds once it is recorded', async () => {
  updateFailures = 2;
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(updates().length, 3);
});

test('if email_verified cannot be recorded, tokens are withheld (retryable temporary_error)', async () => {
  updateFailures = 99;
  const res = await call();
  assert.equal(res.statusCode, 500);
  const body = JSON.parse(res.body as string);
  assert.equal(body.error, 'temporary_error');
  assert.equal(body.accessToken, undefined);
  assert.equal(updates().length, 3);
});
