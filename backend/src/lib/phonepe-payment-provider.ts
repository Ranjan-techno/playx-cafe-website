// Phase 3A: a structural placeholder for the real PhonePe integration. Deliberately does NOT
// implement PhonePe's authentication/signature scheme (X-VERIFY header, checksum, OAuth — whatever
// the finalized integration turns out to need) — this repo has no PhonePe merchant credentials or
// final API documentation yet, and the brief for this phase is explicit: "Do NOT guess PhonePe
// authentication/signature implementation yet."
//
// What this class *does* establish: the shape a real implementation must fill in
// (PaymentProviderAdapter, see payment-provider.ts) and where its credentials will come from once
// they exist (AWS Secrets Manager, injected in the constructor — never a hardcoded value in this
// file, never an environment variable holding a secret directly). Every method throws until a
// later phase replaces it with a real implementation; nothing constructs this class from any
// handler today.

import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProviderAdapter,
  ProviderStatusResult,
  RefundRequest,
  RefundResult,
  WebhookVerificationResult,
} from './payment-provider';

export interface PhonePeCredentials {
  /** Placeholder shape only — the real field set (merchant id, salt key/index, client id/secret,
   *  environment, etc.) depends on which PhonePe API version/auth scheme is finalized, and isn't
   *  guessed at here. Loaded from Secrets Manager by whatever later phase wires this up — see this
   *  file's header. */
  [field: string]: string;
}

const NOT_IMPLEMENTED =
  'PhonePePaymentProvider is not implemented yet — Phase 3A is database/domain foundation only, ' +
  'and this repo has no finalized PhonePe credentials or API documentation to build against ' +
  '(see this file\'s header). A later phase replaces this stub.';

export class PhonePePaymentProvider implements PaymentProviderAdapter {
  readonly provider = 'phonepe' as const;

  constructor(private readonly credentials: PhonePeCredentials) {}

  async createPayment(_request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async getPaymentStatus(_providerOrderId: string): Promise<ProviderStatusResult> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async verifyWebhook(
    _payload: string,
    _headers: Record<string, string | undefined>,
  ): Promise<WebhookVerificationResult | null> {
    throw new Error(NOT_IMPLEMENTED);
  }

  async refundPayment(_request: RefundRequest): Promise<RefundResult> {
    throw new Error(NOT_IMPLEMENTED);
  }
}
