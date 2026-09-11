// Phase 3A: starts a new payment attempt for a booking — the BOOKING HOLD side of the flow, before
// any PAYMENT PAID transition exists to run. No handler calls this yet (see this phase's brief:
// no new API route/webhook infra is added), but it's the natural next call site once a "create
// payment" endpoint exists: it derives the expected amount from the booking's own server-side
// price (never the browser), then hands that — and nothing else — to the given
// PaymentProviderAdapter.
//
// Owns its own transaction, same rationale as confirm-successful-payment.ts: a complete,
// self-contained unit of work with nothing else to share a transaction with.

import { randomUUID } from 'node:crypto';
import type { DbClient } from './allocate-simulators';
import { BookingNotFoundError, BookingNotPayableError } from './payment-errors';
import { createPaymentAttempt as insertPaymentAttempt, lockBookingForPayment } from './payment-repository';
import type { PaymentProviderAdapter } from './payment-provider';

export interface InitiatePaymentInput {
  bookingId: string;
  /** A short line for the provider's own dashboard/receipt — see CreatePaymentRequest.description.
   *  Never used in any decision this codebase makes. */
  description: string;
  /** Generates the merchant-side provider_order_id — injected rather than always calling
   *  randomUUID() directly, so a test can pass a deterministic generator. Defaults to randomUUID(),
   *  same id scheme bookings/payments/etc. already use for their own primary keys
   *  (gen_random_uuid() at the DB layer; this one is generated in the application because it must
   *  exist *before* the INSERT, to hand to the provider in the same call). */
  generateProviderOrderId?: () => string;
}

export interface InitiatePaymentResult {
  paymentId: string;
  providerOrderId: string;
  amountInr: string;
  currency: string;
  /** Where to send the customer to complete payment, when the provider is redirect-based (absent
   *  for the mock provider). */
  redirectUrl?: string;
}

function defaultGenerateProviderOrderId(): string {
  return randomUUID();
}

/**
 * Creates a new 'created' payment attempt against `bookingId`, using `booking.price_inr` (locked,
 * server-side) as the amount — never a client-supplied price. Rejects a booking that isn't
 * currently 'pending' (e.g. already 'confirmed', or 'cancelled') since a new payment attempt only
 * ever makes sense against a booking still awaiting one; this is what keeps a stray/duplicate
 * "create payment" call from ever producing an attempt against a booking a previous attempt has
 * already confirmed.
 */
export async function initiatePayment(
  db: DbClient,
  provider: PaymentProviderAdapter,
  input: InitiatePaymentInput,
): Promise<InitiatePaymentResult> {
  const generateProviderOrderId = input.generateProviderOrderId ?? defaultGenerateProviderOrderId;

  try {
    await db.query('BEGIN');

    const booking = await lockBookingForPayment(db, input.bookingId);
    if (!booking) {
      throw new BookingNotFoundError(input.bookingId);
    }
    if (booking.status !== 'pending') {
      throw new BookingNotPayableError(booking.id, booking.status);
    }

    const providerOrderId = generateProviderOrderId();
    const amountInr = Number(booking.price_inr);
    const currency = 'INR';

    const providerResult = await provider.createPayment({
      providerOrderId,
      amountInr,
      currency,
      description: input.description,
    });

    const paymentRow = await insertPaymentAttempt(db, {
      bookingId: booking.id,
      provider: provider.provider,
      providerOrderId,
      amountInr: booking.price_inr, // the exact NUMERIC string from bookings, avoids float round-trip
      currency,
      metadata: providerResult.raw ? { createPaymentResponse: providerResult.raw } : null,
    });

    await db.query('COMMIT');

    return {
      paymentId: paymentRow.id,
      providerOrderId,
      amountInr: paymentRow.amount_inr,
      currency: paymentRow.currency,
      redirectUrl: providerResult.redirectUrl,
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
