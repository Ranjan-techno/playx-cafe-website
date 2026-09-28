// Stage 3A.1: walk-in bookings — a customer booked and paid at the Play X front desk by an admin.
//
// ONE INVENTORY, ONE ALLOCATION ENGINE: a walk-in is a normal `bookings` row (booking_source =
// 'WALK_IN', migration 011) allocated by the very same lockSimulatorInventory() ->
// findAvailableSimulators() -> insertAllocations() sequence POST /bookings uses (see
// allocate-simulators.ts), against PRODUCTION occupancy — the same occupancy live online bookings
// use. So a walk-in on S1 18:00-18:30 makes S1 busy for playxcafe.com's GET /availability/production
// and POST /bookings/production the moment it commits, and vice versa. There is no second
// allocation implementation here.
//
// TRUST: the request supplies only a product code, date, start time, the customer's contact
// details, a counter payment method (+ optional reference) and notes. Everything else — price,
// duration, racers, simulator type/requirement, the simulators themselves, booking status,
// payment amount/status, environment — is derived server-side here. Unknown body fields are never
// read (same field-by-field parsing as create-booking.ts's parseBody).
//
// IDENTITY: cognito_sub stays NULL (a walk-in customer has no account); the recording admin's
// verified sub goes to created_by_admin_sub. GET /bookings/me scopes on cognito_sub, so a walk-in can
// never appear in anybody's My Bookings — including the admin's own.
//
// ATOMICITY (one transaction): booking INSERT (confirmed) -> simulators lock -> PRODUCTION occupancy
// -> CONFIRMED allocations (never a HOLD) -> counter payment (paid). If capacity is gone the whole
// transaction is rolled back — no booking, allocation or payment row survives.
//
// NO EMAIL: nothing here touches booking_notifications (the confirmation email outbox is only ever
// written by confirm-successful-payment.ts for verified PhonePe payments) or Cognito.

import { randomUUID } from 'node:crypto';
import { findAvailableSimulators, insertAllocations, lockSimulatorInventory, type DbClient } from './allocate-simulators';
import { normalizeEmail } from './email';
import type { AppEnvironment } from './environment';
import { istPartsToUtcDate, parseTimeToMinutes, toIstDateTimeParts, validateBookingSchedule } from './opening-hours';
import { normalizeIndianPhone } from './phone';
import { loadBookableSessionProduct, type SessionProductRow } from './session-product';
import { requirementForProduct, SLOT_STEP_MINUTES } from './simulator-allocation';

/** Walk-ins are always real venue business — never a staging/test booking. */
export const WALK_IN_ENVIRONMENT: AppEnvironment = 'PRODUCTION';

export const COUNTER_PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'COMPLIMENTARY'] as const;
export type CounterPaymentMethod = (typeof COUNTER_PAYMENT_METHODS)[number];

/** Methods that may carry an optional reference (UPI UTR / card slip number). */
const REFERENCE_METHODS: readonly CounterPaymentMethod[] = ['UPI', 'CARD'];

const PRODUCT_CODE_RE = /^[a-z0-9-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const NAME_MAX_LENGTH = 100;
const NOTES_MAX_LENGTH = 500;
export const PAYMENT_REFERENCE_MAX_LENGTH = 64;
// A reference is an identifier, not free text: letters, digits and a few separators only.
const PAYMENT_REFERENCE_RE = /^[A-Za-z0-9 ._/-]+$/;

export interface WalkInRequest {
  productCode: string;
  bookingDate: string;
  startTime: string;
  customer: { name: string; phone: string; email: string | null };
  paymentMethod: CounterPaymentMethod;
  paymentReference: string | null;
  notes: string | null;
}

export type WalkInParseResult = { ok: true; value: WalkInRequest } | { ok: false; message: string };

function invalid(message: string): WalkInParseResult {
  return { ok: false, message };
}

export function isCounterPaymentMethod(value: unknown): value is CounterPaymentMethod {
  return typeof value === 'string' && (COUNTER_PAYMENT_METHODS as readonly string[]).includes(value);
}

/** Absent/null/blank -> null; otherwise trimmed and bounded, or undefined when unacceptable. */
function optionalText(raw: unknown, maxLength: number): string | null | undefined {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.length > maxLength ? undefined : trimmed;
}

/**
 * Field-by-field parse of POST /admin/bookings/walk-in's body. Only the fields below are read;
 * anything else (price, amount, duration, racers, simulator ids, status, environment, ...) is
 * ignored and can never influence the booking. Returns a human-readable message for the counter UI
 * on failure — never echoing the submitted values back.
 */
export function parseWalkInBody(raw: string | undefined | null): WalkInParseResult {
  if (!raw) {
    return invalid('Request body is required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return invalid('Request body must be JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('Request body must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;

  const { productCode, bookingDate, startTime, customer, paymentMethod, paymentReference, notes } = body;
  if (typeof productCode !== 'string' || !PRODUCT_CODE_RE.test(productCode)) {
    return invalid('productCode is required');
  }
  if (typeof bookingDate !== 'string' || !DATE_RE.test(bookingDate)) {
    return invalid('bookingDate must be YYYY-MM-DD');
  }
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
    return invalid('startTime must be HH:MM (24-hour)');
  }

  if (typeof customer !== 'object' || customer === null || Array.isArray(customer)) {
    return invalid('customer { name, phone, email? } is required');
  }
  const c = customer as Record<string, unknown>;
  const name = optionalText(c.name, NAME_MAX_LENGTH);
  if (!name) {
    return invalid(`customer.name is required (max ${NAME_MAX_LENGTH} characters)`);
  }
  const phone = normalizeIndianPhone(c.phone);
  if (!phone) {
    return invalid('customer.phone must be a valid 10-digit Indian mobile number');
  }
  let email: string | null = null;
  const rawEmail = optionalText(c.email, 254);
  if (rawEmail === undefined) {
    return invalid('customer.email must be a valid email address or null');
  }
  if (rawEmail !== null) {
    email = normalizeEmail(rawEmail);
    if (!email) {
      return invalid('customer.email must be a valid email address or null');
    }
  }

  if (!isCounterPaymentMethod(paymentMethod)) {
    return invalid(`paymentMethod must be one of ${COUNTER_PAYMENT_METHODS.join(', ')}`);
  }

  const reference = optionalText(paymentReference, PAYMENT_REFERENCE_MAX_LENGTH);
  if (reference === undefined || (reference !== null && !PAYMENT_REFERENCE_RE.test(reference))) {
    return invalid(
      `paymentReference must be up to ${PAYMENT_REFERENCE_MAX_LENGTH} letters, digits, spaces or . _ / - characters`,
    );
  }
  if (reference !== null && !REFERENCE_METHODS.includes(paymentMethod)) {
    return invalid('paymentReference is only accepted for UPI or CARD payments');
  }

  const trimmedNotes = optionalText(notes, NOTES_MAX_LENGTH);
  if (trimmedNotes === undefined) {
    return invalid(`notes must be text of at most ${NOTES_MAX_LENGTH} characters`);
  }

  return {
    ok: true,
    value: {
      productCode,
      bookingDate,
      startTime,
      customer: { name, phone, email },
      paymentMethod,
      paymentReference: reference,
      notes: trimmedNotes,
    },
  };
}

export interface WalkInScheduleViolation {
  code: 'invalid_date' | 'closed' | 'invalid_time' | 'not_yet_open';
  message: string;
}

/**
 * Walk-in time rules (Stage 3A MVP): exactly the online opening-hours rules
 * (validateBookingSchedule — past date, Grand Opening, Monday closed, 11:00-23:00, must finish by
 * closing), plus two counter-specific ones:
 *   - the start time must sit on the same 15-minute grid GET /availability enumerates
 *     (SLOT_STEP_MINUTES), so a walk-in never fragments the online slot grid;
 *   - a start time that has already passed (even earlier today) is rejected. "Start now" is a later
 *     stage. The comparison uses `now` (injected for tests), in absolute time.
 * There is no maximum-future-date rule for online bookings today, so none is applied here either.
 */
export function validateWalkInSchedule(
  bookingDate: string,
  startTime: string,
  durationMinutes: number,
  now: Date,
): WalkInScheduleViolation | null {
  const base = validateBookingSchedule(bookingDate, startTime, durationMinutes);
  if (base) {
    return base;
  }
  const startMinutes = parseTimeToMinutes(startTime);
  if (startMinutes % SLOT_STEP_MINUTES !== 0) {
    return { code: 'invalid_time', message: `startTime must be on the ${SLOT_STEP_MINUTES}-minute grid (e.g. 18:00, 18:15)` };
  }
  if (scheduledStartFor(bookingDate, startTime).getTime() < now.getTime()) {
    return { code: 'invalid_time', message: 'startTime has already passed' };
  }
  return null;
}

function scheduledStartFor(bookingDate: string, startTime: string): Date {
  const [year, month, day] = bookingDate.split('-').map(Number);
  const startMinutes = parseTimeToMinutes(startTime);
  return istPartsToUtcDate(year, month, day, Math.floor(startMinutes / 60), startMinutes % 60);
}

/** Amount actually collected at the counter: the list price, or ₹0 for COMPLIMENTARY. */
export function counterAmountInr(method: CounterPaymentMethod, listPriceInr: string): string {
  return method === 'COMPLIMENTARY' ? '0.00' : listPriceInr;
}

export interface WalkInBookingResponse {
  id: string;
  bookingNumber: number;
  bookingSource: 'WALK_IN';
  status: 'confirmed';
  product: {
    code: string;
    name: string;
    simulatorType: 'static' | 'motion' | null;
    racers: number;
    durationMinutes: number;
  };
  date: string;
  startTime: string;
  endTime: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  priceInr: number;
  payment: { method: CounterPaymentMethod; status: 'paid'; amountInr: number };
  simulators: string[];
  customer: { name: string; phone: string; email: string | null };
}

export type CreateWalkInResult =
  | { outcome: 'created'; booking: WalkInBookingResponse }
  | { outcome: 'product_error'; statusCode: 400 | 404; error: string; message: string }
  | { outcome: 'schedule_error'; error: WalkInScheduleViolation['code']; message: string }
  | { outcome: 'capacity_unavailable' };

/**
 * Creates one walk-in atomically. Owns its transaction (BEGIN/COMMIT/ROLLBACK) like
 * transitionBookingStatus(); a thrown error is rolled back and re-thrown for the handler to map to
 * a 500. `adminSub` must be authorizeAdmin()'s verified sub, never request data.
 *
 * Lock order matches the global order (booking -> simulators -> allocations; the payment row is a
 * brand-new INSERT nobody else can lock), so this can't deadlock with a payment confirmation or an
 * online booking — it simply queues behind them on the simulators lock.
 */
export async function createWalkInBooking(
  db: DbClient,
  request: WalkInRequest,
  adminSub: string,
  now: Date,
): Promise<CreateWalkInResult> {
  if (typeof adminSub !== 'string' || adminSub.length === 0) {
    throw new Error('createWalkInBooking: adminSub is required');
  }

  // Read-only validation first — nothing is written if the product or time is unacceptable.
  const lookup = await loadBookableSessionProduct(db, request.productCode);
  if (!lookup.ok) {
    return { outcome: 'product_error', statusCode: lookup.statusCode, error: lookup.error, message: lookup.message };
  }
  const product: SessionProductRow = lookup.product;

  const violation = validateWalkInSchedule(request.bookingDate, request.startTime, product.duration_minutes, now);
  if (violation) {
    return { outcome: 'schedule_error', error: violation.code, message: violation.message };
  }

  const scheduledStartAt = scheduledStartFor(request.bookingDate, request.startTime);
  const scheduledEndAt = new Date(scheduledStartAt.getTime() + product.duration_minutes * 60_000);
  const requirement = requirementForProduct({ simulatorType: product.simulator_type, racers: product.racers });
  const amountInr = counterAmountInr(request.paymentMethod, product.price_inr);

  try {
    await db.query('BEGIN');

    // status 'confirmed' and booking_source 'WALK_IN' are literals; cognito_sub is NULL; the
    // environment is the WALK_IN_ENVIRONMENT constant; booking_number comes from its DEFAULT.
    const { rows: bookingRows } = await db.query<{ id: string; booking_number: number }>(
      `INSERT INTO bookings
         (product_id, cognito_sub, customer_name, customer_phone, customer_email,
          racers, duration_minutes, simulator_type, price_inr, status,
          scheduled_start_at, scheduled_end_at, notes, booking_environment,
          booking_source, created_by_admin_sub)
       VALUES
         ($1, NULL, $2, $3, $4,
          $5, $6, $7, $8, 'confirmed',
          $9, $10, $11, $12,
          'WALK_IN', $13)
       RETURNING id, booking_number`,
      [
        product.id,
        request.customer.name,
        request.customer.phone,
        request.customer.email,
        product.racers,
        product.duration_minutes,
        product.simulator_type,
        product.price_inr,
        scheduledStartAt,
        scheduledEndAt,
        request.notes,
        WALK_IN_ENVIRONMENT,
        adminSub,
      ],
    );
    const booking = bookingRows[0];

    // The shared allocation engine, against PRODUCTION occupancy.
    const inventory = await lockSimulatorInventory(db);
    const picked = await findAvailableSimulators(db, inventory, {
      bookingId: booking.id,
      requirement,
      scheduledStartAt,
      scheduledEndAt,
      environment: WALK_IN_ENVIRONMENT,
    });
    if (picked === null) {
      await db.query('ROLLBACK');
      return { outcome: 'capacity_unavailable' };
    }
    // holdExpiresAt = null -> 'confirmed' allocation rows: paid at the desk, nothing to expire.
    await insertAllocations(db, booking.id, picked, scheduledStartAt, scheduledEndAt, null);

    // The counter payment: provider 'counter', final 'paid', never a gateway attempt. The order id
    // is an internal, non-PII unique token; the optional reference (UPI/card) goes to
    // provider_transaction_id.
    await db.query(
      `INSERT INTO payments
         (booking_id, provider, provider_order_id, provider_transaction_id, amount_inr, currency,
          payment_status, paid_at, payment_method, metadata, payment_environment)
       VALUES
         ($1, 'counter', $2, $3, $4, 'INR',
          'paid', now(), $5, $6, $7)`,
      [
        booking.id,
        `walkin-${randomUUID()}`,
        request.paymentReference,
        amountInr,
        request.paymentMethod,
        { source: 'WALK_IN', paymentEnvironment: WALK_IN_ENVIRONMENT, listPriceInr: product.price_inr },
        WALK_IN_ENVIRONMENT,
      ],
    );

    await db.query('COMMIT');

    const start = toIstDateTimeParts(scheduledStartAt);
    const end = toIstDateTimeParts(scheduledEndAt);
    return {
      outcome: 'created',
      booking: {
        id: booking.id,
        bookingNumber: booking.booking_number,
        bookingSource: 'WALK_IN',
        status: 'confirmed',
        product: {
          code: product.product_code,
          name: product.name,
          simulatorType: product.simulator_type,
          racers: product.racers,
          durationMinutes: product.duration_minutes,
        },
        date: start.date,
        startTime: start.time,
        endTime: end.time,
        scheduledStartAt: scheduledStartAt.toISOString(),
        scheduledEndAt: scheduledEndAt.toISOString(),
        priceInr: Number(product.price_inr),
        payment: { method: request.paymentMethod, status: 'paid', amountInr: Number(amountInr) },
        simulators: picked.map((simulator) => simulator.code),
        customer: { ...request.customer },
      },
    };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
