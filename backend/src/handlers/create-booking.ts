import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { allocateSimulators } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { normalizeEmail } from '../lib/email';
import { errorResponse, jsonResponse } from '../lib/http';
import { istPartsToUtcDate, parseTimeToMinutes, validateBookingSchedule } from '../lib/opening-hours';
import { normalizeIndianPhone } from '../lib/phone';
import { requirementForProduct } from '../lib/simulator-allocation';

// Story 2.6: POST /bookings — creates a pending booking for the authenticated Cognito user.
//
// Requires the Cognito JWT authorizer (see infra/lib/constructs/api.ts): the caller's identity
// is the verified "sub" claim API Gateway attaches to event.requestContext.authorizer.jwt.claims
// after validating the token's signature/issuer/audience — never a user id from the request
// body. The body is parsed field-by-field (parseBody below), so even if a client stuffs a
// cognitoSub/userId/price/status field into the JSON, those keys are simply never read.
//
// The price stored is always looked up from the products table, never trusted from the client
// (the request body has no price field to begin with). Booking status is always the literal
// 'pending' — never accepted as input.
//
// customer_name/customer_phone/customer_email are a contact-details *snapshot* taken at booking
// time (the reservation form collects them alongside the Xperience/date/time) — distinct from the
// Cognito identity above, which is what actually owns/authorizes the booking. Two different guests
// signed into the same Cognito account, or a guest booking on someone else's behalf, is why these
// aren't just read off the JWT/User Pool profile.
//
// Phase 2 (automated simulator availability and allocation): the INSERT below now runs inside a
// transaction, and after the booking row is written, lib/allocate-simulators.ts's
// allocateSimulators() locks the simulator inventory and either allocates the physical rig(s) this
// booking needs (HOLD, expiring in HOLD_MINUTES) or the whole transaction is rolled back with a
// 409 — the frontend's own availability display (GET /availability) is never trusted; this is the
// server-side recheck the story asks for. See allocate-simulators.ts's header for the
// transaction/locking strategy itself.

const PRODUCT_CODE_RE = /^[a-z0-9-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const NAME_MAX_LENGTH = 100;
const NOTES_MAX_LENGTH = 500;
// The story's fixed HOLD lifetime: a new reservation's simulator allocation blocks inventory for
// 15 minutes, then — with no payment/confirm step built yet (out of scope this phase, see
// database/migrations/002_simulator_inventory.sql's header) — stops blocking it if nothing has
// moved it out of 'hold' by then.
const HOLD_MINUTES = 15;

export interface CreateBookingBody {
  productCode: string;
  bookingDate: string;
  startTime: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string | null;
}

/** Trims `raw`, rejecting non-strings, empty-after-trim, and anything past `maxLength`. */
function normalizeName(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return null;
  }
  return trimmed;
}

// Exported for create-booking.test.ts: this handler's only AWS/DB-free logic is request-body
// validation, so that's what's unit-tested directly (same pattern as auth-define-challenge.ts/
// auth-verify-challenge.ts, whose tests only cover triggers with no outbound AWS calls) rather
// than mocking getDb()/db.query for the handler as a whole.
export function parseBody(raw: string | undefined): CreateBookingBody | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const body = parsed as Record<string, unknown>;

  const { productCode, bookingDate, startTime, customerName, customerPhone, customerEmail, notes } = body;
  if (typeof productCode !== 'string' || !PRODUCT_CODE_RE.test(productCode)) {
    return null;
  }
  if (typeof bookingDate !== 'string' || !DATE_RE.test(bookingDate)) {
    return null;
  }
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
    return null;
  }

  const name = normalizeName(customerName, NAME_MAX_LENGTH);
  if (!name) {
    return null;
  }
  const phone = normalizeIndianPhone(customerPhone);
  if (!phone) {
    return null;
  }
  const email = normalizeEmail(customerEmail);
  if (!email) {
    return null;
  }

  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return null;
  }
  let trimmedNotes: string | null = null;
  if (typeof notes === 'string') {
    const t = notes.trim();
    if (t.length > NOTES_MAX_LENGTH) {
      return null;
    }
    trimmedNotes = t.length > 0 ? t : null;
  }

  return {
    productCode,
    bookingDate,
    startTime,
    customerName: name,
    customerPhone: phone,
    customerEmail: email,
    notes: trimmedNotes,
  };
}

interface ProductRow {
  id: string;
  product_type: 'session' | 'race_pass';
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  duration_minutes: number;
  price_inr: string; // pg returns NUMERIC as a string
  is_active: boolean;
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    // Defensive only: API Gateway's JWT authorizer should never let a request through without a
    // "sub" claim, since every Cognito-issued token carries one.
    return errorResponse(401, 'unauthenticated', 'Missing subject claim');
  }

  const body = parseBody(event.body);
  if (!body) {
    return errorResponse(
      400,
      'invalid_request',
      'Expected { productCode: string, bookingDate: "YYYY-MM-DD", startTime: "HH:MM", ' +
        'customerName: string, customerPhone: string, customerEmail: string, notes?: string }',
    );
  }

  // Declared outside the try block so the catch handler can best-effort ROLLBACK an
  // in-flight transaction below (e.g. an error between BEGIN and COMMIT) before dropping the
  // connection — otherwise a warm Lambda's cached client (see db.ts) could be reused next
  // invocation while still "idle in transaction" server-side.
  let db: Awaited<ReturnType<typeof getDb>> | undefined;

  try {
    db = await getDb();

    const { rows } = await db.query<ProductRow>(
      `SELECT id, product_type, simulator_type, racers, duration_minutes, price_inr, is_active
       FROM products
       WHERE product_code = $1`,
      [body.productCode],
    );
    const product = rows[0];
    if (!product) {
      return errorResponse(404, 'product_not_found', `No product with code "${body.productCode}"`);
    }
    if (!product.is_active) {
      return errorResponse(400, 'product_inactive', `Product "${body.productCode}" is not currently bookable`);
    }
    if (product.product_type !== 'session') {
      return errorResponse(400, 'product_not_bookable', `Product "${body.productCode}" cannot be booked as a session`);
    }

    // Also enforces the Grand Opening launch restriction (opening-hours.ts's GRAND_OPENING_DATE/
    // GRAND_OPENING_TIME) — a date before 25 Sep 2026, or a startTime before 15:00 on 25 Sep 2026
    // itself, is rejected here (code 'not_yet_open' or 'invalid_time') the same way a Monday or a
    // past date is, regardless of what GET /availability showed or whether the request even called
    // it — a direct POST /bookings can't bypass this by skipping the frontend.
    const violation = validateBookingSchedule(body.bookingDate, body.startTime, product.duration_minutes);
    if (violation) {
      return errorResponse(400, violation.code, violation.message);
    }

    const [year, month, day] = body.bookingDate.split('-').map(Number);
    const startMinutes = parseTimeToMinutes(body.startTime);
    const scheduledStartAt = istPartsToUtcDate(year, month, day, Math.floor(startMinutes / 60), startMinutes % 60);
    const scheduledEndAt = new Date(scheduledStartAt.getTime() + product.duration_minutes * 60_000);
    const requirement = requirementForProduct({ simulatorType: product.simulator_type, racers: product.racers });

    await db.query('BEGIN');

    // booking_number is never listed here and never accepted from the request body (see
    // parseBody/CreateBookingBody above) — it comes entirely from the column's own DEFAULT
    // nextval('booking_number_seq'), added in database/migrations/004_short_booking_number.sql.
    // The database is the sole authoritative generator; the frontend only ever displays whatever
    // comes back below.
    const { rows: inserted } = await db.query<{ id: string; booking_number: number }>(
      `INSERT INTO bookings
         (product_id, cognito_sub, customer_name, customer_phone, customer_email,
          racers, duration_minutes, simulator_type, price_inr, status,
          scheduled_start_at, scheduled_end_at, notes)
       VALUES
         ($1, $2, $3, $4, $5,
          $6, $7, $8, $9, 'pending',
          $10, $11, $12)
       RETURNING id, booking_number`,
      [
        product.id,
        sub,
        body.customerName,
        body.customerPhone,
        body.customerEmail,
        product.racers,
        product.duration_minutes,
        product.simulator_type,
        product.price_inr,
        scheduledStartAt,
        scheduledEndAt,
        body.notes,
      ],
    );
    const bookingId = inserted[0].id;
    const bookingNumber = inserted[0].booking_number;

    // Locks the simulator inventory and allocates the required rig(s), or returns null if the
    // requested window can't be covered — see allocate-simulators.ts for the transaction/locking
    // strategy that makes this safe against two concurrent requests for the same simulator.
    const allocation = await allocateSimulators(db, {
      bookingId,
      requirement,
      scheduledStartAt,
      scheduledEndAt,
      holdMinutes: HOLD_MINUTES,
    });

    if (!allocation) {
      await db.query('ROLLBACK');
      return errorResponse(
        409,
        'simulator_unavailable',
        'No simulator is available for the requested date/time — please choose a different slot',
      );
    }

    await db.query('COMMIT');

    return jsonResponse(201, {
      id: bookingId,
      // Additive field: the 4-digit customer/admin-facing reference (see this repo's CLAUDE.md
      // and 004_short_booking_number.sql). `id` (the UUID) stays exactly as it was — existing
      // clients that only read id/product/price/date/time/status/holdExpiresAt are unaffected.
      bookingNumber,
      product: body.productCode,
      price: Number(product.price_inr),
      date: body.bookingDate,
      time: body.startTime,
      status: 'pending',
      // Additive field: when this HOLD (see allocate-simulators.ts) needs to be confirmed by, once
      // a confirm/payment step exists. Existing clients that only read id/product/price/date/time/
      // status are unaffected.
      holdExpiresAt: allocation.holdExpiresAt.toISOString(),
    });
  } catch (err) {
    if (db) {
      // Best-effort: if the connection itself is what's broken, this just fails too and is
      // ignored — resetDb() below drops it either way.
      await db.query('ROLLBACK').catch(() => {});
    }
    resetDb();
    console.error('POST /bookings failed', err);
    return errorResponse(500, 'internal_error', 'Failed to create booking');
  }
};
