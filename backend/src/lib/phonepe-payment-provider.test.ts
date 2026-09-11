import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhonePePaymentProvider } from './phonepe-payment-provider';

// This phase deliberately does not implement PhonePe's real API/signature scheme (see the file's
// header — no finalized credentials/docs yet). This suite only pins down that the stub is safe:
// every operation fails loudly rather than silently pretending to succeed, so nothing could ever
// mistake it for a working integration.

test('every operation throws "not implemented" rather than silently succeeding', async () => {
  const provider = new PhonePePaymentProvider({ merchantId: 'placeholder' });

  await assert.rejects(
    () => provider.createPayment({ providerOrderId: 'o', amountInr: 100, currency: 'INR', description: 'test' }),
    /not implemented/i,
  );
  await assert.rejects(() => provider.getPaymentStatus('o'), /not implemented/i);
  await assert.rejects(() => provider.verifyWebhook('{}', {}), /not implemented/i);
  await assert.rejects(
    () => provider.refundPayment({ providerOrderId: 'o', providerTransactionId: 't', amountInr: 100, reason: 'test' }),
    /not implemented/i,
  );
});

test('declares itself as the "phonepe" provider', () => {
  const provider = new PhonePePaymentProvider({ merchantId: 'placeholder' });
  assert.equal(provider.provider, 'phonepe');
});
