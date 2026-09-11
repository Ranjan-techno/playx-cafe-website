import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MockPaymentProvider } from './mock-payment-provider';

// The mock provider is test-only (see its file header) — this suite checks its own behavior in
// isolation, independent of the domain-layer tests that use it as a stand-in
// PaymentProviderAdapter elsewhere (create-payment-attempt.test.ts, sync-payment-status.test.ts).

test('createPayment records the order and returns a raw payload for audit', async () => {
  const provider = new MockPaymentProvider();
  const result = await provider.createPayment({ providerOrderId: 'order-1', amountInr: 100, currency: 'INR', description: 'Test' });
  assert.deepEqual(result.raw, { mock: true, providerOrderId: 'order-1' });
});

test('getPaymentStatus defaults to PENDING for an order with no queued outcome', async () => {
  const provider = new MockPaymentProvider();
  const status = await provider.getPaymentStatus('unseen-order');
  assert.equal(status.outcome, 'PENDING');
});

test('queueOutcome makes getPaymentStatus return exactly what was queued', async () => {
  const provider = new MockPaymentProvider();
  provider.queueOutcome('order-2', { outcome: 'SUCCESS', providerTransactionId: 'txn-2', amountInr: 500, currency: 'INR' });
  const status = await provider.getPaymentStatus('order-2');
  assert.equal(status.outcome, 'SUCCESS');
  assert.equal(status.providerTransactionId, 'txn-2');
});

test('verifyWebhook parses a well-formed payload', async () => {
  const provider = new MockPaymentProvider();
  const payload = JSON.stringify({ providerOrderId: 'order-3', outcome: 'SUCCESS', providerTransactionId: 'txn-3', amountInr: 250, currency: 'INR' });
  const result = await provider.verifyWebhook(payload, {});
  assert.ok(result);
  assert.equal(result.providerOrderId, 'order-3');
  assert.equal(result.outcome, 'SUCCESS');
  assert.equal(result.providerTransactionId, 'txn-3');
});

test('verifyWebhook returns null for malformed JSON', async () => {
  const provider = new MockPaymentProvider();
  assert.equal(await provider.verifyWebhook('not json', {}), null);
});

test('verifyWebhook returns null when providerOrderId is missing', async () => {
  const provider = new MockPaymentProvider();
  assert.equal(await provider.verifyWebhook(JSON.stringify({ outcome: 'SUCCESS' }), {}), null);
});

test('verifyWebhook returns null for an unrecognized outcome value', async () => {
  const provider = new MockPaymentProvider();
  assert.equal(await provider.verifyWebhook(JSON.stringify({ providerOrderId: 'order-4', outcome: 'BOGUS' }), {}), null);
});

test('refundPayment returns a deterministic refund id', async () => {
  const provider = new MockPaymentProvider();
  const result = await provider.refundPayment({ providerOrderId: 'order-5', providerTransactionId: 'txn-5', amountInr: 100, reason: 'test' });
  assert.equal(result.providerRefundId, 'mock-refund-txn-5');
});
