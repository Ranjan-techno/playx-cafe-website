import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SandboxTesterNotAllowedError,
  SandboxTestersNotConfiguredError,
  assertPaymentStartAllowed,
  parseSandboxTesters,
} from './sandbox-access';

const SUB = '11111111-2222-3333-4444-555555555555';

test('SANDBOX + missing/empty/blank allowlist fails CLOSED for everyone', () => {
  for (const raw of [undefined, '', '   ', ',,,']) {
    assert.throws(() => assertPaymentStartAllowed('SANDBOX', { sub: SUB }, raw), SandboxTestersNotConfiguredError);
  }
});

test('SANDBOX: a listed Cognito sub is allowed; an unlisted user is denied', () => {
  assertPaymentStartAllowed('SANDBOX', { sub: SUB }, `other-sub, ${SUB}`);
  assert.throws(() => assertPaymentStartAllowed('SANDBOX', { sub: 'someone-else' }, SUB), SandboxTesterNotAllowedError);
});

test('SANDBOX: email match is case-insensitive but only counts when the email is verified', () => {
  assertPaymentStartAllowed('SANDBOX', { sub: 'x', email: 'Tester@Example.com', emailVerified: true }, 'tester@example.com');
  assert.throws(
    () => assertPaymentStartAllowed('SANDBOX', { sub: 'x', email: 'tester@example.com', emailVerified: false }, 'tester@example.com'),
    SandboxTesterNotAllowedError,
  );
  assert.throws(
    () => assertPaymentStartAllowed('SANDBOX', { sub: 'x', email: 'tester@example.com' }, 'tester@example.com'),
    SandboxTesterNotAllowedError,
    'unknown verification status is not trusted',
  );
});

test('PRODUCTION does not use the tester restriction (even with no list configured)', () => {
  assertPaymentStartAllowed('PRODUCTION', { sub: 'anyone' }, undefined);
});

test('reads PHONEPE_SANDBOX_TESTERS from the environment by default; parsing trims and lowercases', () => {
  const saved = process.env.PHONEPE_SANDBOX_TESTERS;
  try {
    process.env.PHONEPE_SANDBOX_TESTERS = ` ${SUB} , A@B.com `;
    assertPaymentStartAllowed('SANDBOX', { sub: SUB });
    delete process.env.PHONEPE_SANDBOX_TESTERS;
    assert.throws(() => assertPaymentStartAllowed('SANDBOX', { sub: SUB }), SandboxTestersNotConfiguredError);
  } finally {
    if (saved === undefined) delete process.env.PHONEPE_SANDBOX_TESTERS;
    else process.env.PHONEPE_SANDBOX_TESTERS = saved;
  }
  assert.deepEqual([...parseSandboxTesters(' A@B.com ,, c ')], ['a@b.com', 'c']);
});
