import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from 'aws-lambda';
import { getDb, resetDb } from '../lib/db';
import { errorResponse, jsonResponse } from '../lib/http';
import { istPartsToUtcDate, parseTimeToMinutes, validateBookingSchedule } from '../lib/opening-hours';

// Story 2.6: POST /bookings — creates a pending booking for the authenticated Cognito user.
//
// Requires the Cognito JWT authorizer (see infra/lib/constructs/api.ts): the caller's identity
// is the verified "sub" claim API Gateway attaches to event.requestContext.authorizer.jwt.claims
// after validating the token's signature/issuer/audience — never a user id from the request
// body, which this route doesn't even accept.
//
// The price stored is always looked up from the products table, never trusted from the client
// (the request body has no price field to begin with). Booking status is always the literal
// 'pending' — never accepted as input.

const PRODUCT_CODE_RE = /^[a-z0-9-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

interface CreateBookingBody {
  productCode: string;
  bookingDate: string;
  startTime: string;
  notes: string | null;
}

function parseBody(raw: string | undefined): CreateBookingBody | null {
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

  const { productCode, bookingDate, startTime, notes } = body;
  if (typeof productCode !== 'string' || !PRODUCT_CODE_RE.test(productCode)) {
    return null;
  }
  if (typeof bookingDate !== 'string' || !DATE_RE.test(bookingDate)) {
    return null;
  }
  if (typeof startTime !== 'string' || !TIME_RE.test(startTime)) {
    return null;
  }
  if (notes !== undefined && notes !== null && typeof notes !== 'string') {
    return null;
  }

  return { productCode, bookingDate, startTime, notes: (notes as string | undefined) ?? null };
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
      'Expected { productCode: string, bookingDate: "YYYY-MM-DD", startTime: "HH:MM", notes?: string }',
    );
  }

  try {
    const db = await getDb();

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

    const violation = validateBookingSchedule(body.bookingDate, body.startTime, product.duration_minutes);
    if (violation) {
      return errorResponse(400, violation.code, violation.message);
    }

    const [year, month, day] = body.bookingDate.split('-').map(Number);
    const startMinutes = parseTimeToMinutes(body.startTime);
    const scheduledStartAt = istPartsToUtcDate(year, month, day, Math.floor(startMinutes / 60), startMinutes % 60);
    const scheduledEndAt = new Date(scheduledStartAt.getTime() + product.duration_minutes * 60_000);

    const { rows: inserted } = await db.query<{ id: string }>(
      `INSERT INTO bookings
         (product_id, cognito_sub, customer_name, customer_phone, customer_email,
          racers, duration_minutes, simulator_type, price_inr, status,
          scheduled_start_at, scheduled_end_at, notes)
       VALUES
         ($1, $2, NULL, NULL, NULL,
          $3, $4, $5, $6, 'pending',
          $7, $8, $9)
       RETURNING id`,
      [
        product.id,
        sub,
        product.racers,
        product.duration_minutes,
        product.simulator_type,
        product.price_inr,
        scheduledStartAt,
        scheduledEndAt,
        body.notes,
      ],
    );

    return jsonResponse(201, {
      id: inserted[0].id,
      product: body.productCode,
      price: Number(product.price_inr),
      date: body.bookingDate,
      time: body.startTime,
      status: 'pending',
    });
  } catch (err) {
    resetDb();
    console.error('POST /bookings failed', err);
    return errorResponse(500, 'internal_error', 'Failed to create booking');
  }
};
