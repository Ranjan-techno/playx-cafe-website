// Environment-driven payment tunables. These are OUR policy knobs, not PhonePe constraints — this
// codebase does not assume any PhonePe-side minimum/maximum order expiry (the installed SDK
// passes `expireAfter` straight through without validating it). Bounds below only keep a
// misconfigured env var from producing a nonsensical hold.

export const DEFAULT_CHECKOUT_HOLD_MINUTES = 20;
const MIN_CHECKOUT_HOLD_MINUTES = 5;
const MAX_CHECKOUT_HOLD_MINUTES = 60;

/** Minutes a simulator hold (and the aligned PhonePe order) lives once checkout starts. */
export function getCheckoutHoldMinutes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PAYMENT_CHECKOUT_HOLD_MINUTES;
  if (raw === undefined || raw === '') {
    return DEFAULT_CHECKOUT_HOLD_MINUTES;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_CHECKOUT_HOLD_MINUTES || value > MAX_CHECKOUT_HOLD_MINUTES) {
    throw new Error(
      `PAYMENT_CHECKOUT_HOLD_MINUTES must be an integer between ${MIN_CHECKOUT_HOLD_MINUTES} and ${MAX_CHECKOUT_HOLD_MINUTES}`,
    );
  }
  return value;
}

/** The customer return page PhonePe redirects to after checkout (PAYMENT_RETURN_URL). Must be an
 *  https URL; unset/blank means "no redirect configured". The redirect is UX only — it is never
 *  payment proof (GET /payments/{id}/status reconciles with the provider). */
export function getPaymentReturnUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.PAYMENT_RETURN_URL?.trim();
  if (!raw) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PAYMENT_RETURN_URL must be a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw new Error('PAYMENT_RETURN_URL must be an https URL');
  }
  return url.toString();
}
