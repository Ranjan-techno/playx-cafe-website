// A scriptable PaymentProviderAdapter for domain tests. Unlike mock-payment-provider.ts it can
// (a) record whether each provider call happened inside a DB transaction, (b) block a call on a
// gate to model a slow provider, and (c) throw arbitrary errors per call.

import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProviderAdapter,
  ProviderStatusResult,
  RefundRequest,
  RefundResult,
  WebhookVerificationResult,
} from '../payment-provider';

export class ScriptedProvider implements PaymentProviderAdapter {
  readonly provider = 'phonepe' as const;
  /** The configured PhonePe environment, like PhonePePaymentProvider.environment. */
  environment: 'SANDBOX' | 'PRODUCTION' = 'SANDBOX';

  createCalls: CreatePaymentRequest[] = [];
  statusCalls: string[] = [];
  /** For each provider call: was `watchedDb` inside a transaction at that instant? */
  callsInsideTransaction: boolean[] = [];

  /** Runs inside every createPayment() call, after it is recorded — for probing DB state/locks. */
  onCreate?: (request: CreatePaymentRequest) => Promise<void>;
  /** When set, createPayment() waits for it (a slow provider). */
  createGate?: Promise<void>;
  createError?: Error | ((callIndex: number) => Error | undefined);
  statuses = new Map<string, ProviderStatusResult | Error>();

  constructor(private readonly watchedDb?: { inTransaction(): boolean }) {}

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const index = this.createCalls.length;
    this.createCalls.push(request);
    this.callsInsideTransaction.push(this.watchedDb?.inTransaction() ?? false);
    await this.onCreate?.(request);
    if (this.createGate) {
      await this.createGate;
    }
    const failure = typeof this.createError === 'function' ? this.createError(index) : this.createError;
    if (failure) {
      throw failure;
    }
    return { redirectUrl: `https://pay.test/${request.providerOrderId}`, providerOrderRef: `OM-${request.providerOrderId}` };
  }

  async getPaymentStatus(providerOrderId: string): Promise<ProviderStatusResult> {
    this.statusCalls.push(providerOrderId);
    this.callsInsideTransaction.push(this.watchedDb?.inTransaction() ?? false);
    const scripted = this.statuses.get(providerOrderId);
    if (scripted instanceof Error) {
      throw scripted;
    }
    return scripted ?? { outcome: 'PENDING' };
  }

  async verifyWebhook(): Promise<WebhookVerificationResult | null> {
    throw new Error('not used');
  }

  async refundPayment(_request: RefundRequest): Promise<RefundResult> {
    throw new Error('not used');
  }
}
