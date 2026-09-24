// PhonePe implementation of PaymentProviderAdapter, on the official Node SDK
// (@phonepe-pg/pg-sdk-node, StandardCheckoutClient — OAuth client-credentials handled inside the
// SDK; no X-VERIFY/salt keys, no hand-rolled auth).
//
// Supports createPayment() and getPaymentStatus() only. verifyWebhook()/refundPayment() throw:
// PhonePe callbacks are authenticated by the PRODUCTION webhook with the SDK's own
// validateCallback() (phonepe-callback.ts / phonepe-runtime.ts) and only ever TRIGGER a
// getPaymentStatus() call, and automated refunds are out of scope for v1.
//
// The SDK client is injected (PhonePeCheckoutClient) so tests never touch the network and this
// module never sees credentials — phonepe-runtime.ts builds the real client from config.

import {
  ClientError,
  ResourceNotFound,
  StandardCheckoutPayRequest,
  type OrderStatusResponse,
  type StandardCheckoutPayResponse,
} from '@phonepe-pg/pg-sdk-node';
import { inrToPaise, paiseToInr } from './money';
import { PaymentProviderError, PaymentProviderOrderNotFoundError } from './payment-errors';
import type {
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProviderAdapter,
  ProviderOutcome,
  ProviderStatusResult,
  RefundRequest,
  RefundResult,
  WebhookVerificationResult,
} from './payment-provider';
import type { PhonePeEnvironment } from './phonepe-config';

/** The slice of StandardCheckoutClient this provider uses. */
export interface PhonePeCheckoutClient {
  pay(request: StandardCheckoutPayRequest): Promise<StandardCheckoutPayResponse>;
  getOrderStatus(merchantOrderId: string, details?: boolean): Promise<OrderStatusResponse>;
}

export interface PhonePeProviderOptions {
  environment: PhonePeEnvironment;
  /** Default customer return URL, used when a request doesn't carry its own. */
  returnUrl?: string;
}

/** PhonePe order state -> the three outcomes the domain layer branches on. Anything unrecognised
 *  is PENDING: an unknown state must never be able to confirm (or fail) a booking. */
export function mapOrderState(state: string | undefined): ProviderOutcome {
  switch ((state ?? '').toUpperCase()) {
    case 'COMPLETED':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

/** Anything below this is taken to be epoch SECONDS (1e12 ms is Sept 2001; 1e12 s is ~33,000 years
 *  out), so both representations normalize to the same instant. */
const EPOCH_SECONDS_THRESHOLD = 1e12;
/** Sanity window for a provider-reported expiry: after 2020-01-01 and before 2100-01-01. */
const MIN_EXPIRY_MS = Date.UTC(2020, 0, 1);
const MAX_EXPIRY_MS = Date.UTC(2100, 0, 1);

/** Normalizes PhonePe's order expiry (typed `expireAt: number`, documented as epoch millis; the raw
 *  API field is `expire_at`) into one UTC Date. Defensive about the runtime shape: epoch seconds or
 *  milliseconds, as a number or an all-digit string. Anything else (missing, non-numeric,
 *  fractional garbage, outside a sane window) -> undefined: an expiry we can't trust is dropped,
 *  never guessed. */
export function normalizeProviderExpiry(value: unknown): Date | undefined {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && /^\d{1,16}$/.test(value.trim())) {
    n = Number(value.trim());
  } else {
    return undefined;
  }
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  const ms = n < EPOCH_SECONDS_THRESHOLD ? n * 1000 : n;
  if (ms < MIN_EXPIRY_MS || ms > MAX_EXPIRY_MS) {
    return undefined;
  }
  return new Date(Math.trunc(ms));
}

/** The expiry field off an SDK response, whichever casing the runtime object actually carries. */
function expiryOf(response: unknown): Date | undefined {
  const r = response as { expireAt?: unknown; expire_at?: unknown } | null | undefined;
  return normalizeProviderExpiry(r?.expireAt ?? r?.expire_at);
}

/** Reduces an SDK exception to status/code only — SDK errors carry the raw response `data`. */
function toProviderError(operation: string, err: unknown): PaymentProviderError {
  const e = err as { httpStatusCode?: number; code?: string } | null;
  const status = typeof e?.httpStatusCode === 'number' ? e.httpStatusCode : undefined;
  const providerCode = typeof e?.code === 'string' ? e.code : undefined;
  const definite = err instanceof ClientError;
  return new PaymentProviderError(
    `PhonePe ${operation} failed${status !== undefined ? ` (HTTP ${status})` : ''}${providerCode ? ` [${providerCode}]` : ''}`,
    definite,
    status,
    providerCode,
  );
}

export class PhonePePaymentProvider implements PaymentProviderAdapter {
  readonly provider = 'phonepe' as const;
  readonly environment: PhonePeEnvironment;

  constructor(
    private readonly client: PhonePeCheckoutClient,
    private readonly options: PhonePeProviderOptions,
  ) {
    this.environment = options.environment;
  }

  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    if (request.currency !== 'INR') {
      throw new PaymentProviderError('PhonePe only supports INR', true);
    }
    const builder = StandardCheckoutPayRequest.builder()
      .merchantOrderId(request.providerOrderId)
      .amount(inrToPaise(request.amountInr));
    const returnUrl = request.returnUrl ?? this.options.returnUrl;
    if (returnUrl) {
      builder.redirectUrl(returnUrl);
    }
    if (request.expireAfterSeconds !== undefined) {
      builder.expireAfter(request.expireAfterSeconds);
    }

    let response: StandardCheckoutPayResponse;
    try {
      response = await this.client.pay(builder.build());
    } catch (err) {
      throw toProviderError('create order', err);
    }
    if (typeof response?.redirectUrl !== 'string' || response.redirectUrl.length === 0) {
      // The order may exist on PhonePe's side, so this is ambiguous, not a definite rejection.
      throw new PaymentProviderError('PhonePe create order returned no redirect URL', false);
    }
    const providerExpiresAt = expiryOf(response);
    return {
      redirectUrl: response.redirectUrl,
      providerOrderRef: response.orderId,
      ...(providerExpiresAt ? { providerExpiresAt } : {}),
      raw: { orderId: response.orderId, state: response.state, expireAt: response.expireAt },
    };
  }

  async getPaymentStatus(providerOrderId: string): Promise<ProviderStatusResult> {
    let response: OrderStatusResponse;
    try {
      response = await this.client.getOrderStatus(providerOrderId, false);
    } catch (err) {
      if (err instanceof ResourceNotFound) {
        throw new PaymentProviderOrderNotFoundError();
      }
      throw toProviderError('order status', err);
    }

    const outcome = mapOrderState(response.state);
    const providerExpiresAt = expiryOf(response);
    const expiry = providerExpiresAt ? { providerExpiresAt } : {};
    // Only the non-sensitive summary is kept: paymentDetails carries instrument/bank details.
    const raw = {
      orderId: response.orderId,
      state: response.state,
      amount: response.amount,
      errorCode: response.errorCode,
      detailedErrorCode: response.detailedErrorCode,
    };
    if (outcome === 'SUCCESS') {
      const completed = response.paymentDetails?.find((detail) => detail.state?.toUpperCase() === 'COMPLETED');
      return {
        outcome,
        providerTransactionId: completed?.transactionId,
        amountInr: paiseToInr(response.amount),
        currency: 'INR',
        ...expiry,
        raw,
      };
    }
    if (outcome === 'FAILED') {
      return {
        outcome,
        failureReason: [response.errorCode, response.detailedErrorCode].filter(Boolean).join('/') || 'FAILED',
        ...expiry,
        raw,
      };
    }
    return { outcome, ...expiry, raw };
  }

  async verifyWebhook(
    _payload: string,
    _headers: Record<string, string | undefined>,
  ): Promise<WebhookVerificationResult | null> {
    throw new Error('PhonePe webhook verification is not implemented yet (callback credentials are not configured)');
  }

  async refundPayment(_request: RefundRequest): Promise<RefundResult> {
    throw new Error('PhonePe refunds are not implemented in v1 — refunds are handled manually');
  }
}
