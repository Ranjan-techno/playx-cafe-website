import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import {
  BadRequest,
  Env,
  ResourceNotFound,
  ServerError,
  StandardCheckoutClient,
  type OrderStatusResponse,
  type StandardCheckoutPayRequest,
  type StandardCheckoutPayResponse,
} from '@phonepe-pg/pg-sdk-node';
import { PaymentProviderError, PaymentProviderOrderNotFoundError } from './payment-errors';
import {
  PhonePePaymentProvider,
  mapOrderState,
  normalizeProviderExpiry,
  type PhonePeCheckoutClient,
} from './phonepe-payment-provider';

// ---------------------------------------------------------------------------------------------
// SDK compatibility: the real StandardCheckoutClient, but with the SDK's own axios pointed at an
// in-memory adapter — so nothing touches the network and no real credential is involved. Guards
// against the reported class-transformer-related auth issue: if the OAuth response were not
// deserialized (plainToClass + @Expose), the second request would carry "undefined undefined".
// ---------------------------------------------------------------------------------------------
test('SDK smoke: imports, initializes, authenticates (OAuth response deserialized) and creates an order', async () => {
  // The exact axios instance the SDK resolves (it is a transitive dependency).
  const sdkRequire = createRequire(require.resolve('@phonepe-pg/pg-sdk-node'));
  const axios = sdkRequire('axios');
  const seen: { url: string; authorization?: string; body?: unknown }[] = [];
  axios.defaults.adapter = async (config: { url: string; headers: Record<string, string>; data?: unknown }) => {
    const now = Math.floor(Date.now() / 1000);
    seen.push({ url: config.url, authorization: config.headers?.Authorization ?? config.headers?.authorization, body: config.data });
    if (config.url.includes('oauth/token')) {
      return {
        status: 200, statusText: 'OK', headers: {}, config,
        data: { access_token: 'FAKE-TOKEN', token_type: 'O-Bearer', expires_in: 3600, issued_at: now, expires_at: now + 3600 },
      };
    }
    return {
      status: 200, statusText: 'OK', headers: {}, config,
      data: { orderId: 'OMO1', state: 'PENDING', expireAt: 1234, redirectUrl: 'https://mercury-uat.example/checkout' },
    };
  };

  const client = StandardCheckoutClient.getInstance('FAKE-CLIENT', 'FAKE-SECRET', 1, Env.SANDBOX, false);
  const provider = new PhonePePaymentProvider(client, { environment: 'SANDBOX', returnUrl: 'https://example.test/return' });
  const result = await provider.createPayment({
    providerOrderId: 'order-1',
    amountInr: '999.00',
    currency: 'INR',
    expireAfterSeconds: 1200,
    description: 'x',
  });

  assert.equal(result.redirectUrl, 'https://mercury-uat.example/checkout');
  assert.equal(result.providerOrderRef, 'OMO1');
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /sandbox.*oauth\/token|oauth\/token/);
  assert.equal(seen[1].authorization, 'O-Bearer FAKE-TOKEN', 'token must be deserialized from access_token/token_type');
  const payBody = JSON.parse(String(seen[1].body));
  assert.equal(payBody.merchantOrderId, 'order-1');
  assert.equal(payBody.amount, 99900, 'rupees converted to integer paise');
  assert.equal(payBody.expireAfter, 1200);
  assert.equal(payBody.paymentFlow.merchantUrls.redirectUrl, 'https://example.test/return');
});

test('SDK dependency versions are what was audited', () => {
  const sdkRequire = createRequire(require.resolve('@phonepe-pg/pg-sdk-node'));
  assert.equal(sdkRequire('@phonepe-pg/pg-sdk-node/package.json').version, '2.0.6');
  assert.equal(sdkRequire('class-transformer/package.json').version, '0.4.0');
});

// ---------------------------------------------------------------------------------------------
// Provider behavior against a scripted client.
// ---------------------------------------------------------------------------------------------
function orderStatus(overrides: Partial<OrderStatusResponse>): OrderStatusResponse {
  return { orderId: 'OMO1', state: 'PENDING', amount: 99900, expireAt: 0, paymentDetails: [], ...overrides } as OrderStatusResponse;
}

function providerWith(client: Partial<PhonePeCheckoutClient>): PhonePePaymentProvider {
  return new PhonePePaymentProvider(client as PhonePeCheckoutClient, { environment: 'SANDBOX' });
}

test('status mapping: COMPLETED -> SUCCESS, FAILED -> FAILED, PENDING -> PENDING, anything unknown -> PENDING (never confirms)', () => {
  assert.equal(mapOrderState('COMPLETED'), 'SUCCESS');
  assert.equal(mapOrderState('completed'), 'SUCCESS');
  assert.equal(mapOrderState('FAILED'), 'FAILED');
  assert.equal(mapOrderState('PENDING'), 'PENDING');
  for (const unknown of ['SUCCESS', 'PAID', 'EXPIRED', '', undefined, 'COMPLETED_PARTIAL']) {
    assert.equal(mapOrderState(unknown), 'PENDING', `state ${String(unknown)}`);
  }
});

test('getPaymentStatus SUCCESS: amount comes back as an exact INR string, transaction id from the COMPLETED attempt', async () => {
  const provider = providerWith({
    getOrderStatus: async () =>
      orderStatus({
        state: 'COMPLETED',
        amount: 115,
        paymentDetails: [
          { transactionId: 'TX-FAILED', state: 'FAILED' },
          { transactionId: 'TX-OK', state: 'COMPLETED' },
        ] as OrderStatusResponse['paymentDetails'],
      }),
  });
  const status = await provider.getPaymentStatus('order-1');
  assert.equal(status.outcome, 'SUCCESS');
  assert.equal(status.amountInr, '1.15');
  assert.equal(status.currency, 'INR');
  assert.equal(status.providerTransactionId, 'TX-OK');
});

test('getPaymentStatus PENDING/FAILED carry no amount and never look like success; FAILED keeps only error codes', async () => {
  const pending = await providerWith({ getOrderStatus: async () => orderStatus({ state: 'PENDING' }) }).getPaymentStatus('o');
  assert.equal(pending.outcome, 'PENDING');
  assert.equal(pending.amountInr, undefined);

  const failed = await providerWith({
    getOrderStatus: async () => orderStatus({ state: 'FAILED', errorCode: 'PAYMENT_ERROR', detailedErrorCode: 'TXN_FAILED' }),
  }).getPaymentStatus('o');
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.failureReason, 'PAYMENT_ERROR/TXN_FAILED');
  assert.equal(failed.amountInr, undefined);
});

test('getPaymentStatus does not retain instrument/bank details in raw', async () => {
  const status = await providerWith({
    getOrderStatus: async () =>
      orderStatus({
        state: 'COMPLETED',
        paymentDetails: [{ transactionId: 'T', state: 'COMPLETED', instrument: { maskedAccountNumber: 'XXXX1234' } }] as unknown as OrderStatusResponse['paymentDetails'],
      }),
  }).getPaymentStatus('o');
  assert.ok(!JSON.stringify(status.raw).includes('XXXX1234'));
});

test('getPaymentStatus: a 404 becomes PaymentProviderOrderNotFoundError; other failures are sanitized provider errors', async () => {
  await assert.rejects(
    () => providerWith({ getOrderStatus: async () => { throw new ResourceNotFound('nope', 404); } }).getPaymentStatus('o'),
    PaymentProviderOrderNotFoundError,
  );
  const leaky = new ServerError('boom', 500);
  (leaky as unknown as { data: unknown }).data = { echoed: 'SECRET-BODY' };
  await assert.rejects(
    () => providerWith({ getOrderStatus: async () => { throw leaky; } }).getPaymentStatus('o'),
    (err: unknown) =>
      err instanceof PaymentProviderError &&
      err.definiteRejection === false &&
      err.httpStatusCode === 500 &&
      !err.message.includes('SECRET-BODY'),
  );
});

test('createPayment builds an SDK request in integer paise with the aligned expiry, and returns redirect + order ref', async () => {
  let captured: StandardCheckoutPayRequest | undefined;
  const provider = providerWith({
    pay: async (request) => {
      captured = request;
      return { orderId: 'OMO9', state: 'PENDING', expireAt: 1, redirectUrl: 'https://pay.example/x' } as StandardCheckoutPayResponse;
    },
  });
  const result = await provider.createPayment({
    providerOrderId: 'merchant-order-9',
    amountInr: '1.15',
    currency: 'INR',
    expireAfterSeconds: 900,
    returnUrl: 'https://site.example/return',
    description: 'ignored',
  });
  assert.equal(captured?.merchantOrderId, 'merchant-order-9');
  assert.equal(captured?.amount, 115);
  assert.equal(captured?.expireAfter, 900);
  assert.equal(result.redirectUrl, 'https://pay.example/x');
  assert.equal(result.providerOrderRef, 'OMO9');
});

test('createPayment error classification: 4xx is a definite rejection, 5xx/network/missing-redirect are ambiguous; messages carry no response data', async () => {
  const badRequest = new BadRequest('bad', 400);
  (badRequest as unknown as { data: unknown }).data = { leaked: 'REQUEST-ECHO' };
  const definite = await providerWith({ pay: async () => { throw badRequest; } })
    .createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' })
    .catch((e) => e);
  assert.ok(definite instanceof PaymentProviderError);
  assert.equal(definite.definiteRejection, true);
  assert.ok(!definite.message.includes('REQUEST-ECHO'));

  const ambiguous = await providerWith({ pay: async () => { throw new ServerError('x', 503); } })
    .createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' })
    .catch((e) => e);
  assert.equal(ambiguous.definiteRejection, false);

  const network = await providerWith({ pay: async () => { throw new Error('ECONNRESET'); } })
    .createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' })
    .catch((e) => e);
  assert.equal(network.definiteRejection, false);

  const noRedirect = await providerWith({ pay: async () => ({ orderId: 'O', state: 'PENDING', expireAt: 1 }) as StandardCheckoutPayResponse })
    .createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' })
    .catch((e) => e);
  assert.equal(noRedirect.definiteRejection, false);
});

test('createPayment rejects non-INR and malformed amounts before any network call', async () => {
  let called = false;
  const provider = providerWith({ pay: async () => { called = true; throw new Error('should not be called'); } });
  await assert.rejects(() => provider.createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'USD', description: '' }));
  await assert.rejects(() => provider.createPayment({ providerOrderId: 'o', amountInr: '1.005', currency: 'INR', description: '' }));
  assert.equal(called, false);
});

test('webhook verification and refunds are explicitly not implemented in v1', async () => {
  const provider = providerWith({});
  assert.equal(provider.provider, 'phonepe');
  await assert.rejects(() => provider.verifyWebhook('{}', {}), /not implemented/);
  await assert.rejects(() => provider.refundPayment({ providerOrderId: 'o', providerTransactionId: 't', amountInr: 1, reason: 'r' }), /not implemented/);
});

// ---------------------------------------------------------------------------------------------
// Stage 2B: provider order expiry (expireAt) normalization — what the fast reconciler stops at.
// ---------------------------------------------------------------------------------------------
const EXPIRY_MS = Date.UTC(2026, 8, 25, 6, 20, 0); // 2026-09-25T06:20:00Z

test('normalizeProviderExpiry: epoch millis and epoch seconds normalize to the same UTC instant', () => {
  assert.equal(normalizeProviderExpiry(EXPIRY_MS)?.toISOString(), '2026-09-25T06:20:00.000Z');
  assert.equal(normalizeProviderExpiry(EXPIRY_MS / 1000)?.toISOString(), '2026-09-25T06:20:00.000Z');
  assert.equal(normalizeProviderExpiry(String(EXPIRY_MS))?.toISOString(), '2026-09-25T06:20:00.000Z');
  assert.equal(normalizeProviderExpiry(` ${EXPIRY_MS / 1000} `)?.toISOString(), '2026-09-25T06:20:00.000Z');
});

test('normalizeProviderExpiry: missing, malformed or implausible values are dropped, never guessed', () => {
  for (const bad of [undefined, null, 0, -1, 1, 1234, Number.NaN, Infinity, '', 'soon', '2026-09-25T06:20:00Z', '1.5e12', {}, [], true,
    Date.UTC(2019, 0, 1), Date.UTC(2101, 0, 1)]) {
    assert.equal(normalizeProviderExpiry(bad), undefined, JSON.stringify(bad));
  }
});

test('createPayment/getPaymentStatus expose the normalized provider expiry (either casing); an unusable one is omitted', async () => {
  const created = await providerWith({
    pay: async () => ({ orderId: 'O', state: 'PENDING', expireAt: EXPIRY_MS, redirectUrl: 'https://pay.example/x' }) as StandardCheckoutPayResponse,
  }).createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' });
  assert.equal(created.providerExpiresAt?.toISOString(), '2026-09-25T06:20:00.000Z');

  const snake = await providerWith({
    pay: async () => ({ orderId: 'O', state: 'PENDING', expire_at: EXPIRY_MS / 1000, redirectUrl: 'https://pay.example/x' }) as unknown as StandardCheckoutPayResponse,
  }).createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' });
  assert.equal(snake.providerExpiresAt?.toISOString(), '2026-09-25T06:20:00.000Z');

  const junk = await providerWith({
    pay: async () => ({ orderId: 'O', state: 'PENDING', expireAt: 1, redirectUrl: 'https://pay.example/x' }) as StandardCheckoutPayResponse,
  }).createPayment({ providerOrderId: 'o', amountInr: '1.00', currency: 'INR', description: '' });
  assert.equal('providerExpiresAt' in junk, false);

  for (const state of ['PENDING', 'FAILED', 'COMPLETED']) {
    const status = await providerWith({
      getOrderStatus: async () => orderStatus({ state, expireAt: EXPIRY_MS, paymentDetails: [{ transactionId: 'T', state: 'COMPLETED' }] as OrderStatusResponse['paymentDetails'] }),
    }).getPaymentStatus('o');
    assert.equal(status.providerExpiresAt?.toISOString(), '2026-09-25T06:20:00.000Z', state);
  }
  const none = await providerWith({ getOrderStatus: async () => orderStatus({ state: 'PENDING', expireAt: 0 }) }).getPaymentStatus('o');
  assert.equal(none.providerExpiresAt, undefined);
});
