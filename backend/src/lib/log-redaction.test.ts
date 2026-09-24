import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhonePeException, ResourceNotFound, ServerError, UnauthorizedAccess } from '@phonepe-pg/pg-sdk-node';
import { describeForLog, installConsoleRedaction, sanitizeLogArgument } from './log-redaction';

// Stage 2E: nothing credential-like may reach CloudWatch through a raw provider object — in
// particular the PhonePe SDK's own `console.warn('No cached token, ...', error)`.

const CLIENT_ID = 'M22-CLIENT-ID-marker-4410';
const CLIENT_SECRET = 'client-secret-marker-a19c';
const WEBHOOK_PASSWORD = 'webhook-password-marker-77d0';
const ACCESS_TOKEN = 'access-token-marker-5e2b';
const INSTRUMENT = 'XXXXXX9876';
const SENSITIVE = [CLIENT_ID, CLIENT_SECRET, WEBHOOK_PASSWORD, ACCESS_TOKEN, INSTRUMENT, 'Authorization', 'O-Bearer', 'Client Not Found'];

/** A real SDK exception, built the way the SDK's HttpCommand builds one from an axios error. */
function oauthClientNotFound(): ResourceNotFound {
  const axiosLike = {
    status: 404,
    statusText: 'Not Found',
    headers: { Authorization: `O-Bearer ${ACCESS_TOKEN}` },
    data: {
      code: 'OIM007',
      message: 'Client Not Found',
      context: { clientId: CLIENT_ID, client_secret: CLIENT_SECRET },
    },
  };
  return new ResourceNotFound('Not Found', 404, axiosLike as never);
}

function captureConsole() {
  const lines: string[] = [];
  const write = (...args: unknown[]) => {
    // What CloudWatch would receive: Node's util.format of the (already sanitized) arguments.
    lines.push(args.map((a) => (typeof a === 'string' ? a : require('node:util').inspect(a, { depth: 10 }))).join(' '));
  };
  const fake = { log: write, info: write, warn: write, error: write, debug: write };
  installConsoleRedaction(fake);
  return { fake, lines };
}

test('the SDK\'s own OAuth-failure warning is reduced to class / HTTP status / provider code', () => {
  const err = oauthClientNotFound();
  // Sanity: the raw SDK exception really does carry the clientId (this is what leaked).
  assert.ok(JSON.stringify(err.data).includes(CLIENT_ID));

  const { fake, lines } = captureConsole();
  fake.warn('No cached token, error occurred while fetching new token', err);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^No cached token, error occurred while fetching new token \[redacted ResourceNotFound httpStatus=404 code=OIM007\]$/);
  for (const value of SENSITIVE) {
    assert.ok(!lines[0].includes(value), `leaked ${value}`);
  }
});

test('every console method is guarded, and nested/sensitive objects never pass through', () => {
  const { fake, lines } = captureConsole();
  const payloads: unknown[] = [
    { clientSecret: CLIENT_SECRET, webhookPassword: WEBHOOK_PASSWORD },
    { headers: { Authorization: `O-Bearer ${ACCESS_TOKEN}` } },
    { access_token: ACCESS_TOKEN, token_type: 'O-Bearer' },
    { payload: { paymentDetails: [{ instrument: { maskedAccountNumber: INSTRUMENT } }] } },
    [CLIENT_ID],
    new Error(`boom ${CLIENT_SECRET}`),
    new ServerError('Internal', 500, { status: 500, data: { message: CLIENT_ID } } as never),
    new UnauthorizedAccess('Unauthorized', 401, { status: 401, data: { code: 'OIM001', context: { clientId: CLIENT_ID } } } as never),
  ];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    for (const payload of payloads) {
      fake[method]('msg', payload);
    }
  }
  assert.equal(lines.length, 5 * payloads.length);
  for (const line of lines) {
    for (const value of SENSITIVE) {
      assert.ok(!line.includes(value), `leaked ${value} in ${line}`);
    }
  }
  assert.ok(lines.some((l) => l.includes('[redacted UnauthorizedAccess httpStatus=401 code=OIM001]')));
  assert.ok(lines.some((l) => l.includes('[redacted ServerError httpStatus=500]')));
});

test('primitive log arguments (our own sanitized messages) are unchanged', () => {
  assert.equal(sanitizeLogArgument('POST /payments/start rejected'), 'POST /payments/start rejected');
  assert.equal(sanitizeLogArgument(404), 404);
  assert.equal(sanitizeLogArgument(false), false);
  assert.equal(sanitizeLogArgument(undefined), undefined);
  assert.equal(sanitizeLogArgument(null), null);
  const json = JSON.stringify({ result: 'confirmed', alreadyConfirmed: false });
  assert.equal(sanitizeLogArgument(json), json);
});

test('a provider code is kept only when it is a short plain token', () => {
  const weird = new PhonePeException('x', 400);
  (weird as { code?: string }).code = `OIM007 ${CLIENT_ID} with spaces`;
  assert.equal(describeForLog(weird), '[redacted PhonePeException httpStatus=400]');
  assert.equal(describeForLog({ some: 'object' }), '[redacted object]');
  assert.equal(describeForLog(() => CLIENT_SECRET), '[redacted function]');
});

test('installation is idempotent (no double wrapping)', () => {
  const lines: unknown[][] = [];
  const write = (...args: unknown[]) => { lines.push(args); };
  const fake = { log: write, info: write, warn: write, error: write, debug: write };
  installConsoleRedaction(fake);
  const wrapped = fake.warn;
  installConsoleRedaction(fake);
  assert.equal(fake.warn, wrapped);
  fake.warn('m', { a: 1 });
  assert.deepEqual(lines, [['m', '[redacted object]']]);
});

test('loading the PhonePe runtime installs the guard on the real console', () => {
  require('./phonepe-runtime');
  const original = process.stderr.write;
  const out: string[] = [];
  // console.warn -> stderr; capture it for this one call.
  process.stderr.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    console.warn('No cached token, error occurred while fetching new token', oauthClientNotFound());
  } finally {
    process.stderr.write = original;
  }
  const text = out.join('');
  assert.match(text, /\[redacted ResourceNotFound httpStatus=404 code=OIM007\]/);
  for (const value of SENSITIVE) {
    assert.ok(!text.includes(value), `leaked ${value}`);
  }
});
