// Starts a checkout for a pending booking, in three stages so that NO PostgreSQL transaction or
// row lock is ever held while waiting on the payment provider's HTTP API:
//
//   TX1  (reservePaymentAttempt)   lock booking -> simulators -> allocations; verify payable;
//                                  verify / re-establish the simulator hold and extend it ONCE;
//                                  reuse an existing open attempt, or insert a new 'created'
//                                  payment row + merchant order id.                      COMMIT
//   ---  provider.createPayment()  network call, no transaction, no locks held.
//   TX2  (recordPaymentCreated)    lock payment; persist redirect URL / order ref, 'created' ->
//                                  'pending'. On a definite provider rejection, mark the attempt
//                                  'failed' instead.                                     COMMIT
//
// Handler responsibilities (not here): authenticate the JWT, check booking ownership, and — for
// SANDBOX — assertPaymentStartAllowed() (sandbox-access.ts).
//
// ENVIRONMENT: `input.environment` is the provider's validated config environment. TX1 refuses
// (PaymentEnvironmentMismatchError) a booking — or an existing open attempt — whose typed
// environment column does not belong to it; NULL/unknown matches no environment and is refused
// (see environment.ts). The new attempt's payment_environment is written from the same value.
//
// LOCK ORDER matches confirm-successful-payment.ts / booking-capacity.ts:
//   payment -> booking -> simulators -> allocations. TX1 has no payment lock to take (it only
//   reads payments, unlocked, after the booking lock), which is what keeps it deadlock-free
//   against a concurrent confirmation that holds payment then waits for booking.
//
// IDEMPOTENCY / double click: TX1 serializes on the booking row, and at most ONE open
// (created/pending) attempt exists per booking at a time:
//   - open attempt with a live redirect            -> returned as-is (reused: true), no provider call
//   - open attempt still being created (< window)  -> PaymentStartInProgressError
//   - open attempt orphaned / past its expiry      -> the provider is asked what happened to it
//       (outside any tx) and that outcome is applied: SUCCESS confirms, FAILED fails it, order
//       unknown at the provider ("never created") fails it; only then may a NEW attempt start.
//       A still-PENDING one blocks a new attempt (PaymentStartInProgressError) — we never open a
//       second live order next to an unresolved one.
//
// HOLD POLICY: starting checkout extends the booking's hold ONCE (tracked as
// payments.metadata.holdExtended on the attempt that did it) to now + checkoutHoldMinutes, capped
// at the session start, never shortening. The provider order expires when the hold does
// (expireAfterSeconds = time left). If the hold had already lapsed, the first start may
// re-establish it if capacity is still free; after the one extension is spent a lapsed hold is
// final (HoldExpiredError) — retries cannot keep re-grabbing capacity forever.

import { randomUUID } from 'node:crypto';
import { findAvailableSimulators, insertAllocations, lockSimulatorInventory, type DbClient } from './allocate-simulators';
import { assertAppEnvironment, storedEnvironmentMatches, type AppEnvironment } from './environment';
import {
  BookingAlreadyPaidError,
  BookingNotFoundError,
  BookingNotPayableError,
  CheckoutWindowClosedError,
  HoldExpiredError,
  PaymentEnvironmentMismatchError,
  PaymentProviderError,
  PaymentProviderOrderNotFoundError,
  PaymentStartInProgressError,
  SimulatorCapacityUnavailableError,
} from './payment-errors';
import type { PaymentProviderAdapter } from './payment-provider';
import {
  createPaymentAttempt,
  listPaymentsForBooking,
  lockAllocationsForBooking,
  lockBookingForPayment,
  lockPaymentById,
  markPaymentFailed,
  markPaymentPending,
  mergePaymentMetadata,
  releaseHeldAllocations,
  setHoldExpiry,
  type PaymentRow,
} from './payment-repository';
import { requirementForProduct } from './simulator-allocation';
import { applyProviderOutcome } from './sync-payment-status';

/** Minimum seconds of checkout window worth starting (our own policy, not a PhonePe rule). */
const MIN_CHECKOUT_SECONDS = 60;
const DEFAULT_IN_FLIGHT_SECONDS = 60;
const MAX_RECOVERY_ROUNDS = 2;

export interface StartPaymentInput {
  bookingId: string;
  /** From the validated PhonePe config (never the request). Must match the booking's
   *  booking_environment; written to payments.payment_environment (mirrored in metadata). */
  environment: AppEnvironment;
  /** Configurable hold/order lifetime once checkout starts (payment-settings.ts). */
  checkoutHoldMinutes: number;
  returnUrl?: string;
  description: string;
  generateProviderOrderId?: () => string;
  /** How long a 'created' attempt without a redirect is assumed to still be mid-flight. */
  inFlightSeconds?: number;
}

export interface StartPaymentResult {
  paymentId: string;
  providerOrderId: string;
  amountInr: string;
  currency: string;
  redirectUrl: string;
  /** When the provider order (and the aligned simulator hold) lapses. */
  expiresAt: Date;
  /** True when an existing live attempt was returned and no provider call was made. */
  reused: boolean;
}

type Reservation =
  | { kind: 'reuse'; result: StartPaymentResult }
  | { kind: 'recover'; payment: PaymentRow }
  | { kind: 'create'; payment: PaymentRow; expiresAt: Date; expireAfterSeconds: number };

function checkoutOf(payment: PaymentRow): { redirectUrl?: string; orderExpiresAt?: Date } {
  const metadata = payment.metadata ?? {};
  const checkout = metadata.checkout as { redirectUrl?: unknown } | undefined;
  const expires = typeof metadata.orderExpiresAt === 'string' ? new Date(metadata.orderExpiresAt) : undefined;
  return {
    redirectUrl: typeof checkout?.redirectUrl === 'string' ? checkout.redirectUrl : undefined,
    orderExpiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : undefined,
  };
}

export async function startPayment(
  db: DbClient,
  provider: PaymentProviderAdapter,
  input: StartPaymentInput,
): Promise<StartPaymentResult> {
  assertAppEnvironment(input.environment, 'environment');
  const generateProviderOrderId = input.generateProviderOrderId ?? randomUUID;

  for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
    // ---- TX1 --------------------------------------------------------------------------------
    const reservation = await reservePaymentAttempt(db, provider, input, generateProviderOrderId);
    if (reservation.kind === 'reuse') {
      return reservation.result;
    }

    if (reservation.kind === 'recover') {
      // ---- outside any transaction: ask the provider what became of the open attempt ---------
      const settled = await recoverOpenAttempt(db, provider, reservation.payment, input.bookingId);
      if (settled === 'retry') {
        continue;
      }
      throw new PaymentStartInProgressError(input.bookingId);
    }

    // ---- outside any transaction: provider HTTP -------------------------------------------
    const { payment, expiresAt, expireAfterSeconds } = reservation;
    let created;
    try {
      created = await provider.createPayment({
        providerOrderId: payment.provider_order_id,
        amountInr: payment.amount_inr,
        currency: payment.currency,
        expireAfterSeconds,
        returnUrl: input.returnUrl,
        description: input.description,
      });
    } catch (err) {
      await recordCreateFailure(db, payment.id, err);
      throw err;
    }
    if (!created.redirectUrl) {
      await recordCreateFailure(db, payment.id, new PaymentProviderError('Provider returned no redirect URL', false));
      throw new PaymentProviderError('Provider returned no redirect URL', false);
    }

    // ---- TX2 --------------------------------------------------------------------------------
    await recordPaymentCreated(db, payment.id, created.redirectUrl, created.providerOrderRef, created.providerExpiresAt);
    return {
      paymentId: payment.id,
      providerOrderId: payment.provider_order_id,
      amountInr: payment.amount_inr,
      currency: payment.currency,
      redirectUrl: created.redirectUrl,
      expiresAt,
      reused: false,
    };
  }
  throw new PaymentStartInProgressError(input.bookingId);
}

async function reservePaymentAttempt(
  db: DbClient,
  provider: PaymentProviderAdapter,
  input: StartPaymentInput,
  generateProviderOrderId: () => string,
): Promise<Reservation> {
  try {
    await db.query('BEGIN');

    const booking = await lockBookingForPayment(db, input.bookingId);
    if (!booking) {
      throw new BookingNotFoundError(input.bookingId);
    }
    if (!storedEnvironmentMatches(booking.booking_environment, input.environment)) {
      throw new PaymentEnvironmentMismatchError(booking.id, input.environment, booking.booking_environment);
    }
    if (booking.status !== 'pending') {
      throw new BookingNotPayableError(booking.id, booking.status);
    }

    // Simulators, then this booking's allocations — the shared lock order.
    const inventory = await lockSimulatorInventory(db);
    const allocations = await lockAllocationsForBooking(db, booking.id);
    const payments = await listPaymentsForBooking(db, booking.id);

    const paid = payments.find((p) => p.payment_status === 'paid');
    if (paid) {
      throw new BookingAlreadyPaidError(booking.id, paid.id);
    }

    const now = new Date();
    const inFlightMs = (input.inFlightSeconds ?? DEFAULT_IN_FLIGHT_SECONDS) * 1000;

    // ---- an open attempt already exists -> never create a second live order ----------------
    const open = payments.find((p) => p.payment_status === 'created' || p.payment_status === 'pending');
    if (open) {
      // Never reuse, or ask this provider about, an attempt that belongs to the other environment.
      if (!storedEnvironmentMatches(open.payment_environment, input.environment)) {
        throw new PaymentEnvironmentMismatchError(booking.id, input.environment, open.payment_environment);
      }
      const { redirectUrl, orderExpiresAt } = checkoutOf(open);
      if (redirectUrl && orderExpiresAt && orderExpiresAt > now && open.provider === provider.provider) {
        await db.query('COMMIT');
        return {
          kind: 'reuse',
          result: {
            paymentId: open.id,
            providerOrderId: open.provider_order_id,
            amountInr: open.amount_inr,
            currency: open.currency,
            redirectUrl,
            expiresAt: orderExpiresAt,
            reused: true,
          },
        };
      }
      if (!redirectUrl && now.getTime() - new Date(open.created_at).getTime() < inFlightMs) {
        throw new PaymentStartInProgressError(booking.id);
      }
      await db.query('COMMIT');
      return { kind: 'recover', payment: open };
    }

    // ---- new attempt: verify / re-establish / extend the simulator hold ---------------------
    const scheduledStart = new Date(booking.scheduled_start_at);
    const scheduledEnd = new Date(booking.scheduled_end_at);
    if (scheduledStart <= now) {
      throw new CheckoutWindowClosedError(booking.id);
    }
    if (allocations.some((row) => row.allocation_status === 'confirmed')) {
      throw new BookingNotPayableError(booking.id, 'pending with confirmed allocations');
    }

    const holds = allocations.filter((row) => row.allocation_status === 'hold');
    const holdValid = holds.length > 0 && holds.every((row) => !row.hold_expired);
    const extensionUsed = payments.some((p) => p.metadata?.holdExtended === true);
    const target = new Date(Math.min(now.getTime() + input.checkoutHoldMinutes * 60_000, scheduledStart.getTime()));

    let holdExpiresAt: Date;
    let holdReestablished = false;
    let extendedNow = false;

    if (holdValid) {
      const current = new Date(Math.max(...holds.map((row) => new Date(row.hold_expires_at as Date).getTime())));
      if (!extensionUsed && target > current) {
        await setHoldExpiry(db, booking.id, target);
        holdExpiresAt = target;
      } else {
        holdExpiresAt = current;
      }
      extendedNow = !extensionUsed;
    } else {
      if (extensionUsed) {
        throw new HoldExpiredError(booking.id);
      }
      // Lapsed (or missing) hold, first start: re-establish only if capacity is still free.
      await releaseHeldAllocations(db, booking.id);
      const picked = await findAvailableSimulators(db, inventory, {
        bookingId: booking.id,
        requirement: requirementForProduct({ simulatorType: booking.simulator_type, racers: booking.racers }),
        scheduledStartAt: scheduledStart,
        scheduledEndAt: scheduledEnd,
      });
      if (picked === null) {
        throw new SimulatorCapacityUnavailableError(booking.id);
      }
      await insertAllocations(db, booking.id, picked, scheduledStart, scheduledEnd, target);
      holdExpiresAt = target;
      holdReestablished = true;
      extendedNow = true;
    }

    // The provider order expires with the hold, but never later than the session start.
    const orderExpiresAt = new Date(Math.min(holdExpiresAt.getTime(), scheduledStart.getTime()));
    const expireAfterSeconds = Math.floor((orderExpiresAt.getTime() - now.getTime()) / 1000);
    if (expireAfterSeconds < MIN_CHECKOUT_SECONDS) {
      throw new CheckoutWindowClosedError(booking.id);
    }

    const payment = await createPaymentAttempt(db, {
      bookingId: booking.id,
      provider: provider.provider,
      providerOrderId: generateProviderOrderId(),
      amountInr: booking.price_inr, // exact NUMERIC string from bookings
      currency: 'INR',
      // Typed payments.payment_environment — from the validated PhonePe config via the handler,
      // never from the request. createPaymentAttempt also mirrors it into
      // metadata.paymentEnvironment (compatibility/display only).
      paymentEnvironment: input.environment,
      metadata: {
        environment: input.environment,
        holdExtended: extendedNow || undefined,
        holdReestablished: holdReestablished || undefined,
        holdExpiresAt: holdExpiresAt.toISOString(),
        orderExpiresAt: orderExpiresAt.toISOString(),
      },
    });
    await db.query('COMMIT');
    return { kind: 'create', payment, expiresAt: orderExpiresAt, expireAfterSeconds };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** TX2, success: persist what the provider returned and move 'created' -> 'pending'. A no-op if
 *  something else (a reconciliation) already moved the attempt on.
 *
 *  metadata.paymentInitiatedAt is when the provider acknowledged the order — what the PRODUCTION
 *  fast-reconcile cadence is measured from (first check 22s later). metadata.providerExpiresAt is
 *  the provider's OWN statement of when the order expires (already
 *  normalized to a UTC instant by the adapter — see normalizeProviderExpiry), kept alongside our
 *  requested metadata.orderExpiresAt. The PRODUCTION fast reconciler stops its cadence there (see
 *  fast-reconcile-payment.ts). Omitted when the provider reported nothing usable. */
async function recordPaymentCreated(
  db: DbClient,
  paymentId: string,
  redirectUrl: string,
  providerOrderRef: string | undefined,
  providerExpiresAt: Date | undefined,
): Promise<void> {
  try {
    await db.query('BEGIN');
    const payment = await lockPaymentById(db, paymentId);
    if (payment && payment.payment_status === 'created') {
      await mergePaymentMetadata(db, paymentId, {
        checkout: { redirectUrl, providerOrderRef: providerOrderRef ?? null },
        paymentInitiatedAt: new Date().toISOString(),
        ...(providerExpiresAt ? { providerExpiresAt: providerExpiresAt.toISOString() } : {}),
      });
      await markPaymentPending(db, paymentId);
    }
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** TX2, failure: only a DEFINITE provider rejection (4xx — no order was created) fails the
 *  attempt. Anything ambiguous (timeout/network/5xx) leaves it 'created' so a later start or
 *  reconciliation asks the provider whether the order actually exists. */
async function recordCreateFailure(db: DbClient, paymentId: string, err: unknown): Promise<void> {
  if (!(err instanceof PaymentProviderError) || !err.definiteRejection) {
    return;
  }
  try {
    await db.query('BEGIN');
    const payment = await lockPaymentById(db, paymentId);
    if (payment && payment.payment_status === 'created') {
      await markPaymentFailed(db, paymentId, `provider_rejected_order: ${err.message}`.slice(0, 200));
    }
    await db.query('COMMIT');
  } catch (txErr) {
    await db.query('ROLLBACK').catch(() => {});
    throw txErr;
  }
}

/** Resolves an open attempt that can't be reused. Returns 'retry' when it is now settled (failed /
 *  never created) and a fresh attempt may start; throws if it turned out PAID; returns 'blocked'
 *  when the provider still reports it PENDING. Runs outside any transaction (provider HTTP), each
 *  DB write being its own short transaction inside applyProviderOutcome / below. */
async function recoverOpenAttempt(
  db: DbClient,
  provider: PaymentProviderAdapter,
  open: PaymentRow,
  bookingId: string,
): Promise<'retry' | 'blocked'> {
  let status;
  try {
    status = await provider.getPaymentStatus(open.provider_order_id);
  } catch (err) {
    if (err instanceof PaymentProviderOrderNotFoundError) {
      // The provider never saw this order: safe to fail it and start over.
      try {
        await db.query('BEGIN');
        const locked = await lockPaymentById(db, open.id);
        if (locked && locked.payment_status === 'created') {
          await markPaymentFailed(db, open.id, 'provider_order_never_created');
        }
        await db.query('COMMIT');
      } catch (txErr) {
        await db.query('ROLLBACK').catch(() => {});
        throw txErr;
      }
      return 'retry';
    }
    throw err;
  }

  const applied = await applyProviderOutcome(db, {
    provider: provider.provider,
    providerOrderId: open.provider_order_id,
    outcome: status.outcome,
    providerTransactionId: status.providerTransactionId,
    amountInr: status.amountInr,
    currency: status.currency,
    failureReason: status.failureReason,
  });
  switch (applied.status) {
    case 'failed':
      return 'retry';
    case 'confirmed':
    case 'paid_refund_required':
      throw new BookingAlreadyPaidError(bookingId, open.id);
    default:
      return 'blocked';
  }
}
