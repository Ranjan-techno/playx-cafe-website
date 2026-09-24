import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  PhonePeConfigError,
  SANDBOX_SECRET_NAME,
  assertSecretMatchesEnvironment,
  loadPhonePeConfig,
  parsePhonePeSecret,
  resetPhonePeConfigCache,
  type SecretStringSource,
} from './phonepe-config';

// Every value below is obviously fake and unique, so a leak check can search for it.
const SECRET_MARKER = 'sup3r-s3cret-marker-9f2c';
const validSecret = {
  clientId: 'TEST-CLIENT-ID-1',
  clientSecret: SECRET_MARKER,
  clientVersion: 1,
  environment: 'SANDBOX',
};

afterEach(() => resetPhonePeConfigCache());

test('parses the current secret shape: clientId, clientSecret, numeric clientVersion, environment — webhook creds optional', () => {
  const config = parsePhonePeSecret(JSON.stringify(validSecret));
  assert.deepEqual(config, { ...validSecret });
  assert.equal(config.webhookUsername, undefined);
  assert.equal(config.webhookPassword, undefined);
});

test('accepts clientVersion as a digit string (Secrets Manager console stores every value as text)', () => {
  assert.equal(parsePhonePeSecret(JSON.stringify({ ...validSecret, clientVersion: '1' })).clientVersion, 1);
});

test('webhook credentials, when present, must come as a non-empty pair', () => {
  const both = parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername: 'u', webhookPassword: 'p' }));
  assert.equal(both.webhookUsername, 'u');
  assert.equal(both.webhookPassword, 'p');
  assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername: 'u' })), PhonePeConfigError);
  assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername: '', webhookPassword: 'p' })), PhonePeConfigError);
});

test('malformed secrets fail closed', () => {
  const bad: unknown[] = [
    { ...validSecret, clientId: undefined },
    { ...validSecret, clientId: '' },
    { ...validSecret, clientId: 5 },
    { ...validSecret, clientSecret: undefined },
    { ...validSecret, clientVersion: 'abc' },
    { ...validSecret, clientVersion: 0 },
    { ...validSecret, clientVersion: 1.5 },
    { ...validSecret, clientVersion: undefined },
    { ...validSecret, environment: 'sandbox' },
    { ...validSecret, environment: 'STAGING' },
    { ...validSecret, environment: undefined },
    [],
    'a string',
    null,
  ];
  for (const value of bad) {
    assert.throws(() => parsePhonePeSecret(JSON.stringify(value)), PhonePeConfigError, JSON.stringify(value));
  }
  assert.throws(() => parsePhonePeSecret(undefined), PhonePeConfigError);
  assert.throws(() => parsePhonePeSecret(''), PhonePeConfigError);
});

test('errors never leak secret text — not for invalid JSON (whose native message quotes the input), nor for bad fields', () => {
  const inputs = [
    `{"clientSecret":"${SECRET_MARKER}", oops`, // invalid JSON containing the secret
    JSON.stringify({ ...validSecret, clientVersion: SECRET_MARKER }),
    JSON.stringify({ ...validSecret, environment: SECRET_MARKER }),
    JSON.stringify({ ...validSecret, clientId: 7, clientSecret: SECRET_MARKER }),
    SECRET_MARKER,
  ];
  for (const input of inputs) {
    try {
      parsePhonePeSecret(input);
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof PhonePeConfigError);
      assert.ok(!(err as Error).message.includes(SECRET_MARKER), `leaked in: ${(err as Error).message}`);
      assert.ok(!String((err as Error).stack).includes(SECRET_MARKER));
      assert.equal((err as Error).cause, undefined, 'must not chain the underlying parse error');
    }
  }
});

test('SANDBOX config must come from the playx/phonepe/sandbox secret (name or ARN); PRODUCTION must never come from a sandbox secret', () => {
  assertSecretMatchesEnvironment(SANDBOX_SECRET_NAME, 'SANDBOX');
  assertSecretMatchesEnvironment(`arn:aws:secretsmanager:ap-south-1:123456789012:secret:${SANDBOX_SECRET_NAME}-AbCdEf`, 'SANDBOX');
  assert.throws(() => assertSecretMatchesEnvironment('playx/phonepe/production', 'SANDBOX'), PhonePeConfigError);
  assert.throws(() => assertSecretMatchesEnvironment(SANDBOX_SECRET_NAME, 'PRODUCTION'), PhonePeConfigError);
  assert.throws(() => assertSecretMatchesEnvironment('prod/phonepe-sandbox-copy', 'PRODUCTION'), PhonePeConfigError);
  assertSecretMatchesEnvironment('playx/phonepe/production', 'PRODUCTION');
});

test('PHONEPE_ENVIRONMENT, when set, must agree with the secret', () => {
  assert.throws(() => assertSecretMatchesEnvironment(SANDBOX_SECRET_NAME, 'SANDBOX', 'PRODUCTION'), PhonePeConfigError);
  assertSecretMatchesEnvironment(SANDBOX_SECRET_NAME, 'SANDBOX', 'SANDBOX');
  assertSecretMatchesEnvironment(SANDBOX_SECRET_NAME, 'SANDBOX', undefined);
});

function fakeSource(value: string | undefined | Error): SecretStringSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getSecretString(secretId: string) {
      calls.push(secretId);
      if (value instanceof Error) {
        throw value;
      }
      return value;
    },
  };
}

test('loadPhonePeConfig: production-named secret holding a SANDBOX environment is rejected (and vice versa)', async () => {
  const src = fakeSource(JSON.stringify({ ...validSecret, environment: 'SANDBOX' }));
  await assert.rejects(() => loadPhonePeConfig({ secretId: 'playx/phonepe/production', source: src }), PhonePeConfigError);
  resetPhonePeConfigCache();
  const prodSecretInSandboxName = fakeSource(JSON.stringify({ ...validSecret, environment: 'PRODUCTION' }));
  await assert.rejects(() => loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: prodSecretInSandboxName }), PhonePeConfigError);
});

test('loadPhonePeConfig: requires a secret name; caches success; shares one in-flight fetch; never caches failure', async () => {
  const saved = process.env.PHONEPE_SECRET_NAME;
  delete process.env.PHONEPE_SECRET_NAME;
  await assert.rejects(() => loadPhonePeConfig({ source: fakeSource('{}') }), /PHONEPE_SECRET_NAME/);
  if (saved !== undefined) process.env.PHONEPE_SECRET_NAME = saved;

  const src = fakeSource(JSON.stringify(validSecret));
  const [a, b] = await Promise.all([
    loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src }),
    loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src }),
  ]);
  assert.equal(a, b);
  await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src });
  assert.equal(src.calls.length, 1, 'one Secrets Manager read for concurrent + subsequent calls');

  resetPhonePeConfigCache();
  const failing = fakeSource(new Error(`AccessDenied ${SECRET_MARKER}`));
  await assert.rejects(
    () => loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: failing }),
    (err: Error) => err instanceof PhonePeConfigError && !err.message.includes(SECRET_MARKER),
  );
  const recovered = fakeSource(JSON.stringify(validSecret));
  await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: recovered });
  assert.equal(recovered.calls.length, 1, 'a failed load is not cached');
});

test('loadPhonePeConfig: cache expires so a rotated secret is picked up', async () => {
  const src = fakeSource(JSON.stringify(validSecret));
  let now = 1_000;
  await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src, now: () => now });
  now += 5 * 60_000;
  await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src, now: () => now });
  assert.equal(src.calls.length, 1);
  now += 6 * 60_000;
  await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: src, now: () => now });
  assert.equal(src.calls.length, 2);
});

test('payment-start does not need webhook credentials: a secret without them loads fine', async () => {
  const config = await loadPhonePeConfig({ secretId: SANDBOX_SECRET_NAME, source: fakeSource(JSON.stringify(validSecret)) });
  assert.equal(config.webhookUsername, undefined);
});

// ----------------------------------------------------------------------------
// Stage 2E: credential whitespace hardening. The production incident: a clientId with ONE trailing
// space passed validation, reached PhonePe and failed there as OIM007 "Client Not Found".
// ----------------------------------------------------------------------------

const CLIENT_ID_MARKER = 'M22CLIENTID-marker-7b1e';

test('clientId with leading/trailing/inner whitespace fails closed before any provider call', () => {
  for (const clientId of [
    `${CLIENT_ID_MARKER} `, // the production incident
    ` ${CLIENT_ID_MARKER}`,
    `${CLIENT_ID_MARKER}\n`,
    `${CLIENT_ID_MARKER}\t`,
    ` ${CLIENT_ID_MARKER}`,
    `M22 CLIENT`,
    '   ',
  ]) {
    assert.throws(
      () => parsePhonePeSecret(JSON.stringify({ ...validSecret, clientId })),
      (err: unknown) => err instanceof PhonePeConfigError && /"clientId"/.test((err as Error).message),
      JSON.stringify(clientId),
    );
  }
  // A clean id is accepted unchanged.
  assert.equal(parsePhonePeSecret(JSON.stringify({ ...validSecret, clientId: CLIENT_ID_MARKER })).clientId, CLIENT_ID_MARKER);
});

test('the whitespace error names the field only — never the clientId, clientSecret or any other value', () => {
  const input = JSON.stringify({ ...validSecret, clientId: `${CLIENT_ID_MARKER} `, webhookUsername: 'hook-user', webhookPassword: SECRET_MARKER });
  try {
    parsePhonePeSecret(input);
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(err instanceof PhonePeConfigError);
    const text = `${(err as Error).message}\n${(err as Error).stack}`;
    for (const value of [CLIENT_ID_MARKER, SECRET_MARKER, 'hook-user']) {
      assert.ok(!text.includes(value), `leaked ${value}`);
    }
  }
});

test('clientVersion as a padded string is refused, not trimmed; exact digits and numbers still work', () => {
  for (const clientVersion of ['1 ', ' 1', '1\n', '\t1', ' ', '1 2']) {
    assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, clientVersion })), PhonePeConfigError, JSON.stringify(clientVersion));
  }
  assert.equal(parsePhonePeSecret(JSON.stringify({ ...validSecret, clientVersion: '2' })).clientVersion, 2);
  assert.equal(parsePhonePeSecret(JSON.stringify({ ...validSecret, clientVersion: 3 })).clientVersion, 3);
});

test('environment must match exactly: padded values are refused', () => {
  for (const environment of ['PRODUCTION ', ' PRODUCTION', 'PRODUCTION\n', 'SANDBOX ', '\tSANDBOX']) {
    assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, environment })), PhonePeConfigError, JSON.stringify(environment));
  }
});

test('webhookUsername with leading/trailing whitespace is refused (inner spaces allowed)', () => {
  for (const webhookUsername of ['user ', ' user', 'user\n', '\tuser']) {
    assert.throws(
      () => parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername, webhookPassword: 'p' })),
      (err: unknown) => err instanceof PhonePeConfigError && /"webhookUsername"/.test((err as Error).message) && !(err as Error).message.includes('user'),
      JSON.stringify(webhookUsername),
    );
  }
  assert.equal(parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername: 'play x', webhookPassword: 'p' })).webhookUsername, 'play x');
});

test('clientSecret and webhookPassword are passed through byte-for-byte — never trimmed or altered', () => {
  for (const value of [` ${SECRET_MARKER}`, `${SECRET_MARKER} `, `a b+/=${SECRET_MARKER}`, `${SECRET_MARKER}é`]) {
    const config = parsePhonePeSecret(JSON.stringify({ ...validSecret, clientSecret: value, webhookUsername: 'u', webhookPassword: value }));
    assert.equal(config.clientSecret, value);
    assert.equal(config.webhookPassword, value);
  }
  // ...but an all-whitespace value is still refused as empty.
  assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, clientSecret: '   ' })), PhonePeConfigError);
  assert.throws(() => parsePhonePeSecret(JSON.stringify({ ...validSecret, webhookUsername: 'u', webhookPassword: ' ' })), PhonePeConfigError);
});

test('loadPhonePeConfig: a padded clientId fails closed and is never cached', async () => {
  let reads = 0;
  const source: SecretStringSource = {
    async getSecretString() {
      reads += 1;
      return JSON.stringify({ ...validSecret, environment: 'PRODUCTION', clientId: `${CLIENT_ID_MARKER} ` });
    },
  };
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(
      () => loadPhonePeConfig({ secretId: 'playx/phonepe/production', source }),
      (err: unknown) => err instanceof PhonePeConfigError && !(err as Error).message.includes(CLIENT_ID_MARKER),
    );
  }
  assert.equal(reads, 2, 'failure not cached');
});
