// PhonePe cutover Stage 2C: the request-level half of the PRODUCTION PhonePe webhook — everything
// between "API Gateway handed us an event" and "we hold a merchantOrderId we can trust". No DB, no
// provider status call, no credentials: the credentials stay inside phonepe-runtime.ts, which hands
// the handler a ready-bound `validateCallback(authorization, rawBody)`.
//
// ORDER OF TRUST: the raw body is never JSON-parsed here, and no payload field is read, until the
// official SDK's StandardCheckoutClient.validateCallback() has accepted the Authorization header.
// That SDK method (@phonepe-pg/pg-sdk-node 2.0.6, dist/payments/v2/StandardCheckoutClient.js):
//   1. compares SHA256("<webhookUsername>:<webhookPassword>") (hex) with the Authorization value
//      and throws PhonePeException('Invalid Callback', 417) on a mismatch — before touching the body;
//   2. only then JSON.parse()s the exact body string (a SyntaxError for a malformed one — whose
//      message can quote the body, so it is never logged) and returns it as a CallbackResponse.
//
// MERCHANT ORDER ID (verified against the installed SDK 2.0.6 type definitions,
// dist/common/models/response/CallbackData.d.ts): an authenticated CallbackResponse is
// `{ type, payload: CallbackData }`, and CallbackData carries
//   - `merchantOrderId?: string`          our own id, the one we passed to pay() as merchantOrderId
//                                          (= payments.provider_order_id) — ORDER callbacks;
//   - `orderId: string`                   PhonePe's INTERNAL order id — never used as a lookup key;
//   - `originalMerchantOrderId?: string`,
//     `merchantRefundId?`, `refundId?`    REFUND callbacks (refunds are manual in v1, not handled).
// So the only field used is `payload.merchantOrderId`. A callback without it (or carrying refund
// identifiers) yields null: nothing is guessed from orderId/originalMerchantOrderId, and the
// webhook acknowledges it without any DB or provider work (fail closed; the 5-minute and fast
// reconcilers still cover every open PRODUCTION attempt).
//
// `type` is deliberately not used: the SDK types it as a numeric enum, its README shows a string,
// and it would be the callback — not PhonePe's authoritative status API — deciding the outcome.

import type { CallbackResponse } from '@phonepe-pg/pg-sdk-node';

/** PhonePe's merchantOrderId rules (max 63 chars; letters, digits, '_' and '-'). Ours are UUIDs
 *  (start-payment.ts), so this only ever rejects something we could not have issued — and it makes
 *  the value safe to log. */
export const MERCHANT_ORDER_ID_RE = /^[A-Za-z0-9_-]{1,63}$/;

/** The exact body string PhonePe sent, as the SDK must see it for validation: base64-decoded when
 *  API Gateway says it encoded the body, otherwise untouched (no trimming, no re-serialising).
 *  Null when there is no body at all. */
export function readRawBody(event: { body?: string | null; isBase64Encoded?: boolean }): string | null {
  const body = event.body;
  if (typeof body !== 'string' || body.length === 0) {
    return null;
  }
  if (!event.isBase64Encoded) {
    return body;
  }
  const decoded = Buffer.from(body, 'base64').toString('utf8');
  return decoded.length > 0 ? decoded : null;
}

/** A header value looked up case-insensitively (HTTP API payload v2 lowercases header names, but
 *  nothing here relies on that). Returns the value exactly as received, or undefined when absent. */
export function headerValue(headers: Record<string, string | undefined> | null | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted && typeof value === 'string') {
      return value;
    }
  }
  return undefined;
}

/** The SDK's validateCallback with the webhook username/password already bound (phonepe-runtime.ts). */
export type BoundCallbackValidator = (authorization: string, rawBody: string) => CallbackResponse;

export type CallbackAuthentication =
  | { ok: true; callback: CallbackResponse }
  /** The SDK rejected the Authorization header. */
  | { ok: false; reason: 'unauthenticated' }
  /** The header was accepted but the body is not a JSON object the SDK could deserialise. */
  | { ok: false; reason: 'malformed' };

/** Runs the SDK's validation and classifies the outcome. Never rethrows an SDK error (their messages
 *  can quote the body) and never inspects the body itself before the SDK has accepted the header. */
export function authenticateCallback(
  validate: BoundCallbackValidator,
  authorization: string,
  rawBody: string,
): CallbackAuthentication {
  let callback: CallbackResponse;
  try {
    callback = validate(authorization, rawBody);
  } catch (err) {
    // SyntaxError can only come from the SDK's JSON.parse, which runs after the header check passed.
    return err instanceof SyntaxError ? { ok: false, reason: 'malformed' } : { ok: false, reason: 'unauthenticated' };
  }
  if (typeof callback !== 'object' || callback === null || Array.isArray(callback)) {
    return { ok: false, reason: 'malformed' };
  }
  return { ok: true, callback };
}

/**
 * The merchantOrderId an AUTHENTICATED callback is about — `payload.merchantOrderId`, our own
 * payments.provider_order_id — or null when the callback does not carry one we could have issued
 * (refund callbacks, a missing/non-string/out-of-format value). Never falls back to PhonePe's
 * internal `orderId` or to `originalMerchantOrderId`. Only call this on a validated callback.
 */
export function extractCallbackMerchantOrderId(callback: CallbackResponse): string | null {
  const payload = (callback as { payload?: unknown }).payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }
  const data = payload as Partial<CallbackResponse['payload']>;
  if (data.merchantRefundId !== undefined || data.refundId !== undefined) {
    return null;
  }
  const id = data.merchantOrderId;
  return typeof id === 'string' && MERCHANT_ORDER_ID_RE.test(id) ? id : null;
}
