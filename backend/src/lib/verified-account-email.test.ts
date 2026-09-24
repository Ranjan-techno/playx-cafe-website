import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { getCognitoClient } from './cognito';
import { resolveVerifiedAccountEmail } from './verified-account-email';

// Stage 2F: the booking-confirmation recipient is the VERIFIED email of the Cognito account that
// owns the booking — resolved server-side from bookings.cognito_sub via ListUsers(sub filter) ->
// AdminGetUser(canonical Username), never assuming the sub is itself a valid Username.

const SUB = '3b994cfd-0b07-4581-be46-3c82f9a70c90';
const CANONICAL = 'canonical-username-from-cognito';

let calls: { command: string; input: any }[] = [];
let listReply: (input: any) => any;
let getReply: (input: any) => any;

beforeEach(() => {
  calls = [];
  listReply = () => ({ Users: [{ Username: CANONICAL, Attributes: [{ Name: 'sub', Value: SUB }] }] });
  getReply = () => user('racer@example.com', 'true');
  (getCognitoClient() as any).send = async (cmd: any) => {
    const command = cmd.constructor.name;
    calls.push({ command, input: cmd.input });
    return command === 'ListUsersCommand' ? listReply(cmd.input) : getReply(cmd.input);
  };
});

const user = (email: string | undefined, verified: string | undefined, sub = SUB, enabled = true) => ({
  Enabled: enabled,
  Username: CANONICAL,
  UserAttributes: [
    { Name: 'sub', Value: sub },
    ...(email !== undefined ? [{ Name: 'email', Value: email }] : []),
    ...(verified !== undefined ? [{ Name: 'email_verified', Value: verified }] : []),
  ],
});

test('finds the account by sub, then reads it by the canonical Username Cognito returned (never Username = sub)', async () => {
  getReply = () => user(' Racer@Example.com ', 'true');
  assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'verified', recipient: { email: 'racer@example.com' } });
  assert.deepEqual(calls, [
    { command: 'ListUsersCommand', input: { UserPoolId: 'pool-1', Filter: `sub = "${SUB}"`, Limit: 2 } },
    { command: 'AdminGetUserCommand', input: { UserPoolId: 'pool-1', Username: CANONICAL } },
  ]);
  assert.ok(!calls.some((c) => c.input.Username === SUB));
});

test('zero matches -> not_found (retryable: ListUsers is eventually consistent), without an AdminGetUser call', async () => {
  for (const users of [[], undefined]) {
    calls = [];
    listReply = () => ({ Users: users });
    assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'not_found' });
    assert.deepEqual(calls.map((c) => c.command), ['ListUsersCommand']);
  }
});

test('more than one match (or a match without a Username) -> unavailable: never picks one arbitrarily', async () => {
  for (const users of [[{ Username: 'a' }, { Username: 'b' }], [{}]]) {
    calls = [];
    listReply = () => ({ Users: users });
    assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'unavailable' });
    assert.deepEqual(calls.map((c) => c.command), ['ListUsersCommand'], 'no AdminGetUser on an ambiguous match');
  }
});

test('a non-UUID sub never reaches a Cognito filter', async () => {
  assert.deepEqual(await resolveVerifiedAccountEmail('x" or email ^= "', 'pool-1'), { kind: 'unavailable' });
  assert.equal(calls.length, 0);
});

test('unverified, missing or malformed email -> unavailable', async () => {
  for (const [email, verified] of [['a@b.com', 'false'], ['a@b.com', undefined], [undefined, 'true'], ['not-an-email', 'true']] as const) {
    getReply = () => user(email, verified);
    assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'unavailable' });
  }
});

test('disabled account, a different sub on the fetched account, or UserNotFoundException -> unavailable', async () => {
  getReply = () => user('a@b.com', 'true', SUB, false);
  assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'unavailable' });
  getReply = () => user('a@b.com', 'true', '5929e0d1-4c34-42d1-9b79-a5ecacfe66f7');
  assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'unavailable' });
  getReply = () => {
    throw Object.assign(new Error('gone'), { name: 'UserNotFoundException' });
  };
  assert.deepEqual(await resolveVerifiedAccountEmail(SUB, 'pool-1'), { kind: 'unavailable' });
});

test('transient Cognito errors propagate (the sender retries); missing USER_POOL_ID throws', async () => {
  listReply = () => {
    throw Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' });
  };
  await assert.rejects(resolveVerifiedAccountEmail(SUB, 'pool-1'), { name: 'TooManyRequestsException' });
  getReply = () => {
    throw Object.assign(new Error('slow down'), { name: 'TooManyRequestsException' });
  };
  listReply = () => ({ Users: [{ Username: CANONICAL }] });
  await assert.rejects(resolveVerifiedAccountEmail(SUB, 'pool-1'), { name: 'TooManyRequestsException' });
  await assert.rejects(resolveVerifiedAccountEmail(SUB, ''), /USER_POOL_ID/);
});
