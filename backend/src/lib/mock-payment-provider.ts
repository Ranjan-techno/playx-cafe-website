// Phase 3A: a deterministic, in-memory PaymentProviderAdapter for automated tests only (see the
// brief's "mock / test provider" section) — never registered against a real handler/route, never
// reachable over HTTP, and never given production credentials or a network call of any kind.
//
// Unlike the real (future) PhonePePaymentProvider, this one never needs credentials, signatures,
// or network I/O: `verifyWebhook` accepts a plain JSON body with no signature check at all, which
// is exactly why this class must never be reachable from a production request path — the module
// comment above and this file's own naming ("mock") are the only guardrails against that, so
// nothing in backend/src/handlers/ may import this file.

import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProviderAdapter,
  ProviderStatusResult,
  RefundRequest,
  RefundResult,
  WebhookVerificationResult,
} from './payment-provider';

/** A test sets the outcome for a given providerOrderId ahead of time (via `queueOutcome`); a
 *  status/webhook call with no queued outcome for that order id defaults to 'PENDING' — mirroring
 *  a real provider's "nothing to report yet" state for an attempt nobody has resolved. */
export class MockPaymentProvider implements PaymentProviderAdapter {
  readonly provider = 'mock' as const;

  private readonly outcomes = new Map<string, ProviderStatusResult>();
  private readonly createdOrders = new Set<string>();

  /** Test setup: makes the next getPaymentStatus()/verifyWebhook() call for `providerOrderId`
   *  return `outcome`. */
  queueOutcome(providerOrderId: string, outcome: ProviderStatusResult): void {
    this.outcomes.set(providerOrderId, outcome);
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    this.createdOrders.add(request.providerOrderId);
    return { raw: { mock: true, providerOrderId: request.providerOrderId } };
  }

  async getPaymentStatus(providerOrderId: string): Promise<ProviderStatusResult> {
    return this.outcomes.get(providerOrderId) ?? { outcome: 'PENDING' };
  }

  /** No signature verification — `payload` is trusted JSON only because this class is test-only
   *  (see this file's header). A real provider adapter's verifyWebhook must never skip signature
   *  verification the way this one deliberately does for tests. */
  async verifyWebhook(payload: string, _headers: Record<string, string | undefined>): Promise<WebhookVerificationResult | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }
    const body = parsed as Record<string, unknown>;
    if (typeof body.providerOrderId !== 'string') {
      return null;
    }
    const outcome = body.outcome;
    if (outcome !== 'SUCCESS' && outcome !== 'FAILED' && outcome !== 'PENDING') {
      return null;
    }
    return {
      providerOrderId: body.providerOrderId,
      outcome,
      providerTransactionId: typeof body.providerTransactionId === 'string' ? body.providerTransactionId : undefined,
      amountInr: typeof body.amountInr === 'number' ? body.amountInr : undefined,
      currency: typeof body.currency === 'string' ? body.currency : undefined,
      failureReason: typeof body.failureReason === 'string' ? body.failureReason : undefined,
    };
  }

  async refundPayment(request: RefundRequest): Promise<RefundResult> {
    return { providerRefundId: `mock-refund-${request.providerTransactionId}` };
  }
}
