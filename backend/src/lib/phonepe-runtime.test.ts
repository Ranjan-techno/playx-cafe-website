import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { loadPhonePeConfig, resetPhonePeConfigCache } from './phonepe-config';
import { getPhonePeWebhookRuntime, WebhookCredentialsUnavailableError } from './phonepe-runtime';

// getPhonePeWebhookRuntime() through the real config loader, with the Secrets Manager read replaced
// by an in-memory source (the loader's cache is primed first, so the runtime never reaches AWS) and
// the real SDK client (building it performs no network I/O with events off).

const SECRET_ID = 'playx/phonepe/production';
const USER = 'SENTINEL-USER';
const PASS = 'SENTINEL-PASS';
const saved = { name: process.env.PHONEPE_SECRET_NAME, env: process.env.PHONEPE_ENVIRONMENT };

async function primeSecret(secret: Record<string, unknown>): Promise<void> {
  resetPhonePeConfigCache();
  await loadPhonePeConfig({ secretId: SECRET_ID, expectedEnvironment: 'PRODUCTION', source: { getSecretString: async () => JSON.stringify(secret) } });
}

const BASE = { clientId: 'FAKE-PROD-CLIENT', clientSecret: 'FAKE-PROD-CLIENT-SECRET', clientVersion: '1', environment: 'PRODUCTION' };

beforeEach(() => {
  process.env.PHONEPE_SECRET_NAME = SECRET_ID;
  process.env.PHONEPE_ENVIRONMENT = 'PRODUCTION';
});

after(() => {
  for (const [key, value] of [['PHONEPE_SECRET_NAME', saved.name], ['PHONEPE_ENVIRONMENT', saved.env]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetPhonePeConfigCache();
});

test('webhook runtime: a secret without webhookUsername/webhookPassword fails closed with a value-free error', async () => {
  await primeSecret(BASE);
  await assert.rejects(getPhonePeWebhookRuntime(), (err: unknown) => {
    assert.ok(err instanceof WebhookCredentialsUnavailableError);
    assert.ok(!/FAKE-PROD/.test(String((err as Error).message)));
    return true;
  });
});

test('webhook runtime: credentials are bound into the SDK validateCallback — the right header validates, anything else throws', async () => {
  await primeSecret({ ...BASE, webhookUsername: USER, webhookPassword: PASS });
  const runtime = await getPhonePeWebhookRuntime();
  assert.equal(runtime.environment, 'PRODUCTION');
  assert.equal(runtime.provider.environment, 'PRODUCTION');
  assert.deepEqual(Object.keys(runtime).sort(), ['environment', 'provider', 'validateCallback'], 'no credential is exposed');
  assert.ok(!JSON.stringify(runtime).includes(PASS));

  const body = JSON.stringify({ type: 'CHECKOUT_ORDER_COMPLETED', payload: { merchantOrderId: 'order-1', orderId: 'OMO1', state: 'COMPLETED' } });
  const good = createHash('sha256').update(`${USER}:${PASS}`).digest('hex');
  const callback = runtime.validateCallback(good, body);
  assert.equal(callback.payload.merchantOrderId, 'order-1');
  assert.throws(() => runtime.validateCallback(createHash('sha256').update(`${USER}:nope`).digest('hex'), body));
  assert.throws(() => runtime.validateCallback('', body));
});
