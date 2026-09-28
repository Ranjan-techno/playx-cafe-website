import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { loadBlockingAllocations, loadLegacyBookingWindows, type DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import { assertAppEnvironment, type AppEnvironment } from '../lib/environment';
import { errorResponse, jsonResponse } from '../lib/http';
import { CLOSE_TIME, effectiveOpenTime, istPartsToUtcDate, parseTimeToMinutes, validateBookingSchedule } from '../lib/opening-hours';
import { computeAvailableSlots, requirementForProduct, type SimulatorRow } from '../lib/simulator-allocation';

// Phase 2: GET /availability?productCode=...&date=YYYY-MM-DD — real, inventory-backed available
// start times for a session product on one calendar day (IST), computed from the same
// simulators/booking_allocations data POST /bookings' allocateSimulators() (see
// lib/allocate-simulators.ts) actually allocates against. Public, like GET /products — a visitor
// browses availability before signing in.
//
// This is informational only: the frontend showing a slot as available here is never sufficient
// to book it — POST /bookings independently rechecks and locks inventory itself (see
// create-booking.ts's header), so a slot that looked free here can still legitimately be rejected
// there if another booking wins the race in between.
//
// Stage 3A.1: environment-scoped. GET /availability is the SANDBOX (staging/test) view and GET
// /availability/production (availability-production.ts) the PRODUCTION one — each counts only
// occupancy from bookings of its own environment (see allocate-simulators.ts's header), so live
// online + walk-in bookings never show up as busy on staging and staging test holds never make a
// production slot look taken. The environment is a deploy-time literal, never request data.

const PRODUCT_CODE_RE = /^[a-z0-9-]+$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AvailabilityQuery {
  productCode: string;
  date: string;
}

// Exported for availability.test.ts, same pattern as create-booking.ts's parseBody: this is the
// only AWS/DB-free logic in this handler.
export function parseQuery(raw: Record<string, string | undefined> | undefined | null): AvailabilityQuery | null {
  const productCode = raw?.productCode;
  const date = raw?.date;
  if (typeof productCode !== 'string' || !PRODUCT_CODE_RE.test(productCode)) {
    return null;
  }
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return null;
  }
  return { productCode, date };
}

interface ProductRow {
  product_type: 'session' | 'race_pass';
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  duration_minutes: number;
  is_active: boolean;
}

export interface AvailabilityDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
}

const defaultDeps: AvailabilityDeps = { getDb, resetDb };

/** Builds the GET availability handler for one hard-coded environment (validated at cold start). */
export function createAvailabilityHandler(availabilityEnvironment: AppEnvironment, deps: AvailabilityDeps = defaultDeps) {
  const environment = assertAppEnvironment(availabilityEnvironment, 'availabilityEnvironment');
  const logLabel = environment === 'PRODUCTION' ? 'GET /availability/production' : 'GET /availability';

  return async (event: Pick<APIGatewayProxyEventV2, 'queryStringParameters'>): Promise<APIGatewayProxyStructuredResultV2> => {
    const query = parseQuery(event.queryStringParameters);
    if (!query) {
      return errorResponse(400, 'invalid_request', 'Expected query params productCode and date=YYYY-MM-DD');
    }

    try {
      const db = await deps.getDb();

      const { rows } = await db.query<ProductRow>(
        `SELECT product_type, simulator_type, racers, duration_minutes, is_active
         FROM products
         WHERE product_code = $1`,
        [query.productCode],
      );
      const product = rows[0];
      if (!product) {
        return errorResponse(404, 'product_not_found', `No product with code "${query.productCode}"`);
      }
      if (!product.is_active) {
        return errorResponse(400, 'product_inactive', `Product "${query.productCode}" is not currently bookable`);
      }
      if (product.product_type !== 'session') {
        return errorResponse(400, 'product_not_bookable', `Product "${query.productCode}" cannot be booked as a session`);
      }

      // Reuses the same date-level rules POST /bookings enforces (past date, Grand Opening launch
      // restriction, Monday closed) — effectiveOpenTime(query.date) is always a valid startTime for
      // any session's duration (max 60 min, closing at 23:00) on a date that isn't itself rejected,
      // so a violation here can only be invalid_date, not_yet_open, or closed, never invalid_time.
      const openTimeForDate = effectiveOpenTime(query.date);
      const dayViolation = validateBookingSchedule(query.date, openTimeForDate, product.duration_minutes);
      if (dayViolation) {
        return jsonResponse(200, {
          productCode: query.productCode,
          date: query.date,
          durationMinutes: product.duration_minutes,
          availableSlots: [],
          closed: true,
          reason: dayViolation.code,
        });
      }

      const requirement = requirementForProduct({ simulatorType: product.simulator_type, racers: product.racers });

      const { rows: inventory } = await db.query<SimulatorRow>(
        `SELECT id, code, simulator_type FROM simulators WHERE is_active = true ORDER BY code`,
      );

      const [year, month, day] = query.date.split('-').map(Number);
      // The whole IST calendar day, generously bounded — opening hours (11:00-23:00) mean nothing
      // can actually start or end outside this, but the query itself doesn't need to know that.
      const dayStartAt = istPartsToUtcDate(year, month, day, 0, 0);
      const dayEndAt = istPartsToUtcDate(year, month, day, 23, 59);

      // Blocking allocations + legacy (allocation-less) bookings of THIS environment only — the same
      // loaders POST /bookings' allocateSimulators() uses under its lock, so the two can't drift.
      const allocations = await loadBlockingAllocations(db, dayStartAt, dayEndAt, environment);
      const legacyBookings = await loadLegacyBookingWindows(db, dayStartAt, dayEndAt, environment, null);

      const availableSlots = computeAvailableSlots({
        dateParts: { year, month, day },
        durationMinutes: product.duration_minutes,
        requirement,
        inventory,
        allocations,
        legacyBookings,
        // Same effective open time as the dayViolation check above — GRAND_OPENING_TIME instead of
        // the usual OPEN_TIME when `query.date` is the Grand Opening date itself, so 25 Sep 2026's
        // first enumerated (and returned) candidate slot is already 15:00, never earlier.
        openMinutes: parseTimeToMinutes(openTimeForDate),
        closeMinutes: parseTimeToMinutes(CLOSE_TIME),
        toUtc: istPartsToUtcDate,
      });

      return jsonResponse(200, {
        productCode: query.productCode,
        date: query.date,
        durationMinutes: product.duration_minutes,
        availableSlots,
      });
    } catch (err) {
      deps.resetDb();
      console.error(`${logLabel} failed`, err);
      return errorResponse(500, 'internal_error', 'Failed to load availability');
    }
  };
}

// GET /availability — the SANDBOX (staging/test) availability view.
export const handler = createAvailabilityHandler('SANDBOX');
