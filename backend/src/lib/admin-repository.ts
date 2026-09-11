// Phase 3B: PLAY X ADMIN — the DB-touching half of every /admin/* handler's data needs, plus the
// pure request-parsing/row-shaping logic that sits next to it (same split as this codebase's other
// domain layers — see simulator-allocation.ts/allocate-simulators.ts and payment-repository.ts/
// confirm-successful-payment.ts). Handlers stay thin: parse the request with one of the
// parse*Query() functions here, call the matching DB function, return its result as JSON.
//
// Every query is parameterized (`$1`, `$2`, ...) — no request-derived value (date, status, search,
// booking id, cursor, limit) is ever concatenated into SQL text. `search` additionally has its
// ILIKE wildcard characters (`%`, `_`, `\`) escaped so a search string can only ever match itself
// literally, never expand into a broader wildcard the caller didn't intend.

import type { DbClient } from './allocate-simulators';
import {
  BOOKING_STATUSES,
  confirmsAllocationOnTransition,
  isAllowedTransition,
  isValidBookingStatus,
  releasesAllocationOnTransition,
  type BookingStatus,
} from './booking-status';
import { istPartsToUtcDate, toIstDateTimeParts } from './opening-hours';
import { confirmBookingAllocations, type PaymentStatus } from './payment-repository';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEARCH_MAX_LENGTH = 100;

/** Bounds every admin list endpoint's page size — item 4's "reasonable maximum page size". */
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Splits an IST calendar date (YYYY-MM-DD) into the [start, end) UTC TIMESTAMPTZ bounds of that
 *  business day — the same istPartsToUtcDate conversion create-booking.ts/availability.ts already
 *  use, so "today" here means exactly what it means everywhere else in this codebase (Asia/Kolkata,
 *  never the Lambda runtime's UTC clock or a browser's local timezone). */
function istDayBounds(istDate: string): { start: Date; end: Date } {
  const [year, month, day] = istDate.split('-').map(Number);
  return {
    start: istPartsToUtcDate(year, month, day, 0, 0),
    // day + 1 deliberately overflows the calendar month — Date.UTC (which istPartsToUtcDate is
    // built on) normalizes that into the correct next day, same trick used for exclusive-end
    // day-boundary math elsewhere in JS date code.
    end: istPartsToUtcDate(year, month, day + 1, 0, 0),
  };
}

/** Escapes `%`, `_`, and the escape character itself so a caller-supplied search term can only
 *  ever match itself literally in an `ILIKE ... ESCAPE '\'` clause — never let a search string
 *  expand into an unintended wildcard match. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export interface QueryValidationError {
  ok: false;
  error: string;
  message: string;
}

function invalid(message: string): QueryValidationError {
  return { ok: false, error: 'invalid_request', message };
}

// ============================================================================
// Keyset pagination — shared by GET /admin/bookings and GET /admin/payments. There's no existing
// pagination convention in this codebase to follow (GET /bookings/me returns everything
// unbounded), so this picks keyset ("give me everything created before this row") over
// offset/limit: stable under concurrent inserts and doesn't degrade as the offset grows, at the
// cost of only supporting "next page", never "jump to page N" — acceptable for an admin console
// no future story has asked for arbitrary-page jumping in.
// ============================================================================

export interface KeysetCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(raw: string): KeysetCursor | null {
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof decoded === 'object' &&
      decoded !== null &&
      typeof (decoded as Record<string, unknown>).createdAt === 'string' &&
      typeof (decoded as Record<string, unknown>).id === 'string' &&
      !Number.isNaN(Date.parse((decoded as { createdAt: string }).createdAt))
    ) {
      return decoded as KeysetCursor;
    }
    return null;
  } catch {
    return null;
  }
}

function parseLimit(raw: string | undefined): number | QueryValidationError {
  if (raw === undefined) {
    return DEFAULT_PAGE_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return invalid('limit must be a positive integer');
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

function parseCursorParam(raw: string | undefined): { ok: true; cursor: KeysetCursor | undefined } | QueryValidationError {
  if (raw === undefined) {
    return { ok: true, cursor: undefined };
  }
  const decoded = decodeCursor(raw);
  if (!decoded) {
    return invalid('cursor is invalid or malformed');
  }
  return { ok: true, cursor: decoded };
}

// ============================================================================
// GET /admin/dashboard
// ============================================================================

export interface DashboardSummary {
  date: string;
  bookings: { total: number; confirmed: number; pending: number; cancelled: number };
  // See buildDashboardSummary()'s doc comment — this is *not* just booking_status = 'pending';
  // it's real allocation-level state, matching availability.ts's own "still blocking" rule.
  holds: { active: number; expired: number };
  payments: { paid: number; pending: number; failed: number };
  revenue: { paidInr: number };
  simulators: { total: number; static: number; motion: number };
}

interface BookingStatusCountRow {
  status: string;
  count: string;
}
interface PaymentStatusCountRow {
  payment_status: string;
  count: string;
}
interface SimulatorTypeCountRow {
  simulator_type: string;
  count: string;
}
/** One row per HOLD booking_allocations row for the day — deliberately raw (not pre-aggregated in
 *  SQL) so buildDashboardSummary() below can do the active/expired split and the distinct-booking
 *  dedup itself, injected with `now` rather than each trusting a DB-side now() and an app-side one
 *  to agree — same "inject, don't call, the clock" rule allocate-simulators.ts's DbClient-free
 *  half (simulator-allocation.ts) already follows. */
interface HoldAllocationRow {
  booking_id: string;
  hold_expires_at: Date;
}

/**
 * Pure shaping of the dashboard response from already-fetched rows — kept separate from
 * getDashboardSummary() below so the counting/bucketing rules are directly unit-testable without a
 * database. Every bucket maps onto a real, existing enum value (see booking_status/payment_status
 * in the migrations) — nothing here is invented:
 *   - bookings.pending is booking_status = 'pending'. This is a booking-lifecycle count, not an
 *     operational "is a simulator currently blocked" count — see `holds` below for that. A pending
 *     booking's allocation may have already expired (nothing auto-releases an expired HOLD row —
 *     see allocate-simulators.ts's occupied-simulators query, which simply *ignores* one) without
 *     the booking itself changing status, so treating every 'pending' booking as an active hold
 *     would overstate how many simulators are actually blocked right now (this phase's audit
 *     brief, Issue 2).
 *   - holds.active/expired are computed from `holdRows` — raw booking_allocations rows already
 *     filtered to allocation_status = 'hold' and scoped to the day — classified against the
 *     injected `now` using the *exact* business rule availability.ts/allocate-simulators.ts use to
 *     decide whether a HOLD still blocks capacity: hold_expires_at > now() is active, <= now() is
 *     expired. Deduplicated by booking_id (a Set per bucket) so a Duo/Grand Race booking with
 *     multiple simulator allocations counts as one hold, not one per rig — this phase's audit
 *     brief, Issue 2's "avoid double-counting".
 *   - payments.pending groups payment_status IN ('created', 'pending') — both describe an attempt
 *     still in flight, awaiting an outcome.
 *   - payments.failed groups payment_status IN ('failed', 'expired') — both are terminal,
 *     unsuccessful outcomes. 'refunded' is deliberately excluded from every bucket (it was 'paid'
 *     first, so double-counting it as revenue-or-not is a future phase's call, not this one's).
 */
export function buildDashboardSummary(
  date: string,
  bookingCounts: BookingStatusCountRow[],
  paymentCounts: PaymentStatusCountRow[],
  paidRevenueInr: number,
  simulatorCounts: SimulatorTypeCountRow[],
  holdRows: HoldAllocationRow[],
  now: Date,
): DashboardSummary {
  const bookingsByStatus = new Map(bookingCounts.map((row) => [row.status, Number(row.count)]));
  const paymentsByStatus = new Map(paymentCounts.map((row) => [row.payment_status, Number(row.count)]));
  const simulatorsByType = new Map(simulatorCounts.map((row) => [row.simulator_type, Number(row.count)]));

  const totalBookings = [...bookingsByStatus.values()].reduce((sum, n) => sum + n, 0);
  const staticCount = simulatorsByType.get('static') ?? 0;
  const motionCount = simulatorsByType.get('motion') ?? 0;

  const nowMs = now.getTime();
  const activeHoldBookingIds = new Set<string>();
  const expiredHoldBookingIds = new Set<string>();
  for (const row of holdRows) {
    (row.hold_expires_at.getTime() > nowMs ? activeHoldBookingIds : expiredHoldBookingIds).add(row.booking_id);
  }

  return {
    date,
    bookings: {
      total: totalBookings,
      confirmed: bookingsByStatus.get('confirmed') ?? 0,
      pending: bookingsByStatus.get('pending') ?? 0,
      cancelled: bookingsByStatus.get('cancelled') ?? 0,
    },
    holds: { active: activeHoldBookingIds.size, expired: expiredHoldBookingIds.size },
    payments: {
      paid: paymentsByStatus.get('paid') ?? 0,
      pending: (paymentsByStatus.get('created') ?? 0) + (paymentsByStatus.get('pending') ?? 0),
      failed: (paymentsByStatus.get('failed') ?? 0) + (paymentsByStatus.get('expired') ?? 0),
    },
    revenue: { paidInr: paidRevenueInr },
    simulators: { total: staticCount + motionCount, static: staticCount, motion: motionCount },
  };
}

/**
 * Bookings, hold-allocation, and payment-attempt counts are all scoped to the IST business day
 * `istDate` (bookings by scheduled_start_at, holds by booking_allocations.scheduled_start_at —
 * same column create-booking.ts/availability.ts already populate per allocation, payment attempts
 * by created_at) — one consistent Asia/Kolkata business-date definition throughout, per this
 * phase's audit brief, Issue 2. Revenue is scoped by paid_at instead of created_at — "today's
 * revenue" means money that actually landed today, not attempts merely started today — and, per
 * the brief, comes only from payment_status = 'paid' rows; nothing unpaid/failed/expired is ever
 * summed into it.
 */
export async function getDashboardSummary(db: DbClient, istDate: string): Promise<DashboardSummary> {
  const { start, end } = istDayBounds(istDate);

  const { rows: bookingCounts } = await db.query<BookingStatusCountRow>(
    `SELECT status, COUNT(*) AS count
     FROM bookings
     WHERE scheduled_start_at >= $1 AND scheduled_start_at < $2
     GROUP BY status`,
    [start, end],
  );

  const { rows: paymentCounts } = await db.query<PaymentStatusCountRow>(
    `SELECT payment_status, COUNT(*) AS count
     FROM payments
     WHERE created_at >= $1 AND created_at < $2
     GROUP BY payment_status`,
    [start, end],
  );

  const { rows: revenueRows } = await db.query<{ sum: string | null }>(
    `SELECT COALESCE(SUM(amount_inr), 0) AS sum
     FROM payments
     WHERE payment_status = 'paid' AND paid_at >= $1 AND paid_at < $2`,
    [start, end],
  );

  const { rows: simulatorCounts } = await db.query<SimulatorTypeCountRow>(
    `SELECT simulator_type, COUNT(*) AS count FROM simulators WHERE is_active = true GROUP BY simulator_type`,
  );

  // Raw rows, not a COUNT — buildDashboardSummary() does the active/expired split and the
  // distinct-booking dedup so both are unit-testable without a database (see its doc comment).
  const { rows: holdRows } = await db.query<HoldAllocationRow>(
    `SELECT booking_id, hold_expires_at
     FROM booking_allocations
     WHERE allocation_status = 'hold' AND scheduled_start_at >= $1 AND scheduled_start_at < $2`,
    [start, end],
  );

  return buildDashboardSummary(istDate, bookingCounts, paymentCounts, Number(revenueRows[0]?.sum ?? 0), simulatorCounts, holdRows, new Date());
}

// ============================================================================
// GET /admin/bookings
// ============================================================================

export interface AdminBookingsQuery {
  date?: string;
  status?: BookingStatus;
  search?: string;
  limit: number;
  cursor?: KeysetCursor;
}

export function parseAdminBookingsQuery(
  raw: Record<string, string | undefined> | null | undefined,
): { ok: true; query: AdminBookingsQuery } | QueryValidationError {
  const date = raw?.date;
  if (date !== undefined && !DATE_RE.test(date)) {
    return invalid('date must be YYYY-MM-DD');
  }

  const status = raw?.status;
  if (status !== undefined && !isValidBookingStatus(status)) {
    return invalid(`status must be one of: ${BOOKING_STATUSES.join(', ')}`);
  }

  let search: string | undefined;
  if (raw?.search !== undefined) {
    const trimmed = raw.search.trim();
    if (trimmed.length > SEARCH_MAX_LENGTH) {
      return invalid(`search must be at most ${SEARCH_MAX_LENGTH} characters`);
    }
    search = trimmed.length > 0 ? trimmed : undefined;
  }

  const limit = parseLimit(raw?.limit);
  if (typeof limit !== 'number') {
    return limit;
  }

  const cursorResult = parseCursorParam(raw?.cursor);
  if (!cursorResult.ok) {
    return cursorResult;
  }

  return { ok: true, query: { date, status, search, limit, cursor: cursorResult.cursor } };
}

interface AdminBookingListRow {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  product_code: string;
  product_name: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  duration_minutes: number;
  price_inr: string;
  status: string;
  created_at: Date;
  simulator_codes: string[] | null;
  latest_payment_status: string | null;
  latest_payment_provider: string | null;
}

export interface AdminBookingListItem {
  id: string;
  // Play X's schema has no separate booking-reference column (see 001_initial_schema.sql) — the
  // UUID primary key is the only stable identifier a booking has, so it doubles as its own
  // "reference" here rather than inventing a second one that doesn't exist in the database.
  bookingReference: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  product: { code: string; name: string };
  date: string;
  time: string;
  durationMinutes: number;
  priceInr: number;
  status: string;
  createdAt: string;
  allocatedSimulators: string[];
  payment: { status: string; provider: string } | null;
}

export function mapAdminBookingListRow(row: AdminBookingListRow): AdminBookingListItem {
  const { date, time } = toIstDateTimeParts(row.scheduled_start_at);
  return {
    id: row.id,
    bookingReference: row.id,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    product: { code: row.product_code, name: row.product_name },
    date,
    time,
    durationMinutes: row.duration_minutes,
    priceInr: Number(row.price_inr),
    status: row.status,
    createdAt: row.created_at.toISOString(),
    allocatedSimulators: row.simulator_codes ?? [],
    payment: row.latest_payment_status
      ? { status: row.latest_payment_status, provider: row.latest_payment_provider ?? 'unknown' }
      : null,
  };
}

export interface AdminBookingsPage {
  items: AdminBookingListItem[];
  nextCursor: string | null;
}

export async function listAdminBookings(db: DbClient, query: AdminBookingsQuery): Promise<AdminBookingsPage> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.date) {
    const { start, end } = istDayBounds(query.date);
    params.push(start, end);
    conditions.push(`b.scheduled_start_at >= $${params.length - 1} AND b.scheduled_start_at < $${params.length}`);
  }
  if (query.status) {
    params.push(query.status);
    conditions.push(`b.status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${escapeLikePattern(query.search)}%`);
    const idx = params.length;
    conditions.push(
      `(b.customer_name ILIKE $${idx} ESCAPE '\\' OR b.customer_email ILIKE $${idx} ESCAPE '\\' OR b.customer_phone ILIKE $${idx} ESCAPE '\\')`,
    );
  }
  if (query.cursor) {
    params.push(new Date(query.cursor.createdAt), query.cursor.id);
    conditions.push(`(b.created_at, b.id) < ($${params.length - 1}, $${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  // Fetches one extra row past the page size so nextCursor can be set without a separate COUNT
  // query — a well-established keyset-pagination trick.
  params.push(query.limit + 1);
  const limitIdx = params.length;

  const { rows } = await db.query<AdminBookingListRow>(
    `SELECT
       b.id, b.customer_name, b.customer_phone, b.customer_email,
       p.product_code, p.name AS product_name,
       b.scheduled_start_at, b.scheduled_end_at, b.duration_minutes, b.price_inr, b.status, b.created_at,
       alloc.codes AS simulator_codes,
       pay.payment_status AS latest_payment_status,
       pay.provider AS latest_payment_provider
     FROM bookings b
     JOIN products p ON p.id = b.product_id
     LEFT JOIN LATERAL (
       SELECT array_agg(s.code ORDER BY s.code) AS codes
       FROM booking_allocations ba
       JOIN simulators s ON s.id = ba.simulator_id
       WHERE ba.booking_id = b.id AND ba.allocation_status <> 'released'
     ) alloc ON true
     LEFT JOIN LATERAL (
       SELECT payment_status, provider FROM payments WHERE booking_id = b.id ORDER BY created_at DESC LIMIT 1
     ) pay ON true
     ${whereClause}
     ORDER BY b.created_at DESC, b.id DESC
     LIMIT $${limitIdx}`,
    params,
  );

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];

  return {
    items: pageRows.map(mapAdminBookingListRow),
    nextCursor: hasMore && lastRow ? encodeCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id }) : null,
  };
}

// ============================================================================
// GET /admin/bookings/{id}
// ============================================================================

interface AdminBookingDetailRow {
  id: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  product_code: string;
  product_name: string;
  racers: number;
  duration_minutes: number;
  simulator_type: string | null;
  price_inr: string;
  status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

interface AdminAllocationDetailRow {
  simulator_code: string;
  simulator_type: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  allocation_status: string;
  hold_expires_at: Date | null;
}

interface AdminPaymentAttemptRow {
  id: string;
  provider: string;
  provider_order_id: string;
  provider_transaction_id: string | null;
  amount_inr: string;
  currency: string;
  payment_status: string;
  failure_reason: string | null;
  created_at: Date;
  paid_at: Date | null;
}

export interface AdminBookingDetail {
  id: string;
  bookingReference: string;
  customer: { name: string | null; email: string | null; phone: string | null };
  product: { code: string; name: string; racers: number; durationMinutes: number; simulatorType: string | null };
  priceInr: number;
  status: string;
  date: string;
  time: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  notes: string | null;
  allocations: {
    simulatorCode: string;
    simulatorType: string;
    status: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    holdExpiresAt: string | null;
  }[];
  payments: {
    id: string;
    provider: string;
    providerOrderId: string;
    providerTransactionId: string | null;
    amountInr: number;
    currency: string;
    status: string;
    failureReason: string | null;
    createdAt: string;
    paidAt: string | null;
  }[];
  currentPaymentStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Pure shaping, unit-testable without a database — mirrors buildDashboardSummary()'s split.
 *  `payments` must already be ordered most-recent-first (see getAdminBookingDetail's query):
 *  currentPaymentStatus prefers a 'paid' attempt (the durable outcome) over a later, irrelevant
 *  retry, falling back to the most recent attempt of any status, or null if there's never been
 *  one. */
export function buildAdminBookingDetail(
  booking: AdminBookingDetailRow,
  allocations: AdminAllocationDetailRow[],
  payments: AdminPaymentAttemptRow[],
): AdminBookingDetail {
  const { date, time } = toIstDateTimeParts(booking.scheduled_start_at);
  const paidAttempt = payments.find((p) => p.payment_status === 'paid');
  const currentPaymentStatus = paidAttempt?.payment_status ?? payments[0]?.payment_status ?? null;

  return {
    id: booking.id,
    bookingReference: booking.id,
    customer: { name: booking.customer_name, email: booking.customer_email, phone: booking.customer_phone },
    product: {
      code: booking.product_code,
      name: booking.product_name,
      racers: booking.racers,
      durationMinutes: booking.duration_minutes,
      simulatorType: booking.simulator_type,
    },
    priceInr: Number(booking.price_inr),
    status: booking.status,
    date,
    time,
    scheduledStartAt: booking.scheduled_start_at.toISOString(),
    scheduledEndAt: booking.scheduled_end_at.toISOString(),
    notes: booking.notes,
    allocations: allocations.map((a) => ({
      simulatorCode: a.simulator_code,
      simulatorType: a.simulator_type,
      status: a.allocation_status,
      scheduledStartAt: a.scheduled_start_at.toISOString(),
      scheduledEndAt: a.scheduled_end_at.toISOString(),
      holdExpiresAt: a.hold_expires_at ? a.hold_expires_at.toISOString() : null,
    })),
    payments: payments.map((p) => ({
      id: p.id,
      provider: p.provider,
      providerOrderId: p.provider_order_id,
      providerTransactionId: p.provider_transaction_id,
      amountInr: Number(p.amount_inr),
      currency: p.currency,
      status: p.payment_status,
      failureReason: p.failure_reason,
      createdAt: p.created_at.toISOString(),
      paidAt: p.paid_at ? p.paid_at.toISOString() : null,
    })),
    currentPaymentStatus,
    createdAt: booking.created_at.toISOString(),
    updatedAt: booking.updated_at.toISOString(),
  };
}

/** Returns null for an unknown booking id — the handler turns that into 404, never a 500. Never
 *  reads/returns any Cognito data (customer_name/email/phone here is the booking's own contact
 *  *snapshot*, not a Cognito profile lookup — see create-booking.ts's header) or anything from the
 *  payments.metadata JSONB blob. */
export async function getAdminBookingDetail(db: DbClient, bookingId: string): Promise<AdminBookingDetail | null> {
  const { rows } = await db.query<AdminBookingDetailRow>(
    `SELECT b.id, b.customer_name, b.customer_phone, b.customer_email,
            p.product_code, p.name AS product_name, b.racers, b.duration_minutes, b.simulator_type,
            b.price_inr, b.status, b.scheduled_start_at, b.scheduled_end_at, b.notes, b.created_at, b.updated_at
     FROM bookings b
     JOIN products p ON p.id = b.product_id
     WHERE b.id = $1`,
    [bookingId],
  );
  const booking = rows[0];
  if (!booking) {
    return null;
  }

  const { rows: allocations } = await db.query<AdminAllocationDetailRow>(
    `SELECT s.code AS simulator_code, s.simulator_type,
            ba.scheduled_start_at, ba.scheduled_end_at, ba.allocation_status, ba.hold_expires_at
     FROM booking_allocations ba
     JOIN simulators s ON s.id = ba.simulator_id
     WHERE ba.booking_id = $1
     ORDER BY s.code`,
    [bookingId],
  );

  const { rows: payments } = await db.query<AdminPaymentAttemptRow>(
    `SELECT id, provider, provider_order_id, provider_transaction_id, amount_inr, currency,
            payment_status, failure_reason, created_at, paid_at
     FROM payments
     WHERE booking_id = $1
     ORDER BY created_at DESC`,
    [bookingId],
  );

  return buildAdminBookingDetail(booking, allocations, payments);
}

// ============================================================================
// GET /admin/payments
// ============================================================================

const PAYMENT_STATUSES: readonly PaymentStatus[] = ['created', 'pending', 'paid', 'failed', 'expired', 'refunded'];

function isValidPaymentStatus(value: string): value is PaymentStatus {
  return (PAYMENT_STATUSES as readonly string[]).includes(value);
}

export interface AdminPaymentsQuery {
  status?: PaymentStatus;
  bookingId?: string;
  date?: string;
  limit: number;
  cursor?: KeysetCursor;
}

export function parseAdminPaymentsQuery(
  raw: Record<string, string | undefined> | null | undefined,
): { ok: true; query: AdminPaymentsQuery } | QueryValidationError {
  const status = raw?.status;
  if (status !== undefined && !isValidPaymentStatus(status)) {
    return invalid(`status must be one of: ${PAYMENT_STATUSES.join(', ')}`);
  }

  const bookingId = raw?.bookingId;
  if (bookingId !== undefined && !isValidUuid(bookingId)) {
    return invalid('bookingId must be a valid UUID');
  }

  const date = raw?.date;
  if (date !== undefined && !DATE_RE.test(date)) {
    return invalid('date must be YYYY-MM-DD');
  }

  const limit = parseLimit(raw?.limit);
  if (typeof limit !== 'number') {
    return limit;
  }

  const cursorResult = parseCursorParam(raw?.cursor);
  if (!cursorResult.ok) {
    return cursorResult;
  }

  return { ok: true, query: { status, bookingId, date, limit, cursor: cursorResult.cursor } };
}

interface AdminPaymentListRow {
  id: string;
  booking_id: string;
  provider: string;
  provider_order_id: string;
  provider_transaction_id: string | null;
  amount_inr: string;
  currency: string;
  payment_status: string;
  failure_reason: string | null;
  created_at: Date;
  paid_at: Date | null;
}

export interface AdminPaymentListItem {
  id: string;
  bookingId: string;
  provider: string;
  providerOrderId: string;
  providerTransactionId: string | null;
  amountInr: number;
  currency: string;
  status: string;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** Deliberately never includes payments.metadata (the raw provider payload) — see this phase's
 *  brief, item 6: no API secrets, provider credentials, or unvetted raw metadata leave this
 *  endpoint, only the specific typed fields listed above. */
export function mapAdminPaymentListRow(row: AdminPaymentListRow): AdminPaymentListItem {
  return {
    id: row.id,
    bookingId: row.booking_id,
    provider: row.provider,
    providerOrderId: row.provider_order_id,
    providerTransactionId: row.provider_transaction_id,
    amountInr: Number(row.amount_inr),
    currency: row.currency,
    status: row.payment_status,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
  };
}

export interface AdminPaymentsPage {
  items: AdminPaymentListItem[];
  nextCursor: string | null;
}

export async function listAdminPayments(db: DbClient, query: AdminPaymentsQuery): Promise<AdminPaymentsPage> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.status) {
    params.push(query.status);
    conditions.push(`payment_status = $${params.length}`);
  }
  if (query.bookingId) {
    params.push(query.bookingId);
    conditions.push(`booking_id = $${params.length}`);
  }
  if (query.date) {
    const { start, end } = istDayBounds(query.date);
    params.push(start, end);
    conditions.push(`created_at >= $${params.length - 1} AND created_at < $${params.length}`);
  }
  if (query.cursor) {
    params.push(new Date(query.cursor.createdAt), query.cursor.id);
    conditions.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(query.limit + 1);
  const limitIdx = params.length;

  const { rows } = await db.query<AdminPaymentListRow>(
    `SELECT id, booking_id, provider, provider_order_id, provider_transaction_id,
            amount_inr, currency, payment_status, failure_reason, created_at, paid_at
     FROM payments
     ${whereClause}
     ORDER BY created_at DESC, id DESC
     LIMIT $${limitIdx}`,
    params,
  );

  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  const lastRow = pageRows[pageRows.length - 1];

  return {
    items: pageRows.map(mapAdminPaymentListRow),
    nextCursor: hasMore && lastRow ? encodeCursor({ createdAt: lastRow.created_at.toISOString(), id: lastRow.id }) : null,
  };
}

// ============================================================================
// GET /admin/simulators — read-only board for one IST calendar day.
// ============================================================================

export interface SimulatorBoardEntry {
  bookingId: string;
  bookingStatus: string;
  allocationStatus: string;
  scheduledStartAt: string;
  scheduledEndAt: string;
  holdExpiresAt: string | null;
  // Issue 3: lets the future UI tell an active hold/confirmed allocation (currently blocks this
  // rig) apart from an expired hold/released one (doesn't) without reimplementing the business
  // rule itself — same allocation_status = 'confirmed' OR (= 'hold' AND hold_expires_at > now())
  // test availability.ts/allocate-simulators.ts use to decide what's still occupied. Purely
  // derived from the other fields on this entry; never changes what's actually bookable.
  blocksCapacity: boolean;
}

export interface SimulatorBoardItem {
  code: string;
  type: string;
  entries: SimulatorBoardEntry[];
}

interface SimulatorInventoryRow {
  id: string;
  code: string;
  simulator_type: string;
}

interface SimulatorBoardAllocationRow {
  booking_id: string;
  simulator_id: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  allocation_status: string;
  hold_expires_at: Date | null;
  booking_status: string;
}

/**
 * Pure shaping: groups every allocation row overlapping the requested day under its simulator,
 * unit-testable without a database. Deliberately includes every allocation_status (hold,
 * confirmed, and released) rather than pre-filtering to "still active" the way
 * allocate-simulators.ts/availability.ts do for booking purposes — this is an operational read-only
 * board, not an availability check (see this phase's brief, item 7), so a released/cancelled or
 * expired-hold entry stays visible with its true status/hold_expires_at rather than being hidden,
 * letting the future admin UI decide how to style it. This never changes what's actually available
 * to book — no availability logic here is reused or altered. `now` is injected (see
 * SimulatorBoardEntry's `blocksCapacity` doc comment) rather than read internally, so this stays
 * directly unit-testable without a database or a real clock.
 */
export function buildSimulatorBoard(
  simulators: SimulatorInventoryRow[],
  allocations: SimulatorBoardAllocationRow[],
  now: Date,
): SimulatorBoardItem[] {
  const nowMs = now.getTime();
  return simulators.map((simulator) => ({
    code: simulator.code,
    type: simulator.simulator_type,
    entries: allocations
      .filter((allocation) => allocation.simulator_id === simulator.id)
      .map((allocation) => ({
        bookingId: allocation.booking_id,
        bookingStatus: allocation.booking_status,
        allocationStatus: allocation.allocation_status,
        scheduledStartAt: allocation.scheduled_start_at.toISOString(),
        scheduledEndAt: allocation.scheduled_end_at.toISOString(),
        holdExpiresAt: allocation.hold_expires_at ? allocation.hold_expires_at.toISOString() : null,
        blocksCapacity:
          allocation.allocation_status === 'confirmed' ||
          (allocation.allocation_status === 'hold' &&
            allocation.hold_expires_at !== null &&
            allocation.hold_expires_at.getTime() > nowMs),
      })),
  }));
}

export async function getSimulatorBoard(db: DbClient, istDate: string): Promise<SimulatorBoardItem[]> {
  const { start, end } = istDayBounds(istDate);

  const { rows: simulators } = await db.query<SimulatorInventoryRow>(
    `SELECT id, code, simulator_type FROM simulators WHERE is_active = true ORDER BY code`,
  );

  const { rows: allocations } = await db.query<SimulatorBoardAllocationRow>(
    `SELECT ba.booking_id, ba.simulator_id, ba.scheduled_start_at, ba.scheduled_end_at,
            ba.allocation_status, ba.hold_expires_at, b.status AS booking_status
     FROM booking_allocations ba
     JOIN bookings b ON b.id = ba.booking_id
     WHERE ba.scheduled_start_at < $2 AND ba.scheduled_end_at > $1
     ORDER BY ba.scheduled_start_at`,
    [start, end],
  );

  return buildSimulatorBoard(simulators, allocations, new Date());
}

// ============================================================================
// PATCH /admin/bookings/{id}/status
// ============================================================================

export type TransitionBookingStatusResult =
  | { outcome: 'not_found' }
  | { outcome: 'invalid_transition'; from: string; to: BookingStatus }
  | { outcome: 'ok'; id: string; status: BookingStatus };

/**
 * Locks the booking row, validates the requested transition against booking-status.ts's whitelist,
 * and then does exactly one of:
 *   - for a target that confirmsAllocationOnTransition() (today: 'confirmed' — an admin manually
 *     confirming a pending walk-in/cash booking): confirms this booking's still-HOLD allocation
 *     row(s) — allocation_status = 'confirmed', hold_expires_at = NULL — via the same
 *     confirmBookingAllocations() a successful payment already uses, so the booking is never left
 *     'confirmed' while an allocation is still a temporary, expirable HOLD (this phase's audit
 *     brief, Issue 1).
 *   - for a target that releasesAllocationOnTransition() (today: 'cancelled'): releases this
 *     booking's still-blocking (hold or confirmed) allocation rows, so a cancelled booking's
 *     simulator(s) stop blocking future availability immediately (see this phase's brief, item 8's
 *     "critical example").
 * All of this happens in the one transaction started by `BEGIN` below — a thrown error at any
 * point rolls the whole thing back (booking status, allocation rows) via the catch block, so a
 * booking can never be left 'confirmed'/'cancelled' with its allocations in a stale state. Never
 * touches the payments table either way — payment state stays entirely separate, per item 9; this
 * endpoint represents an explicit manual/offline confirmation, never a substitute for
 * confirm-successful-payment.ts's PhonePe-driven one.
 */
export async function transitionBookingStatus(
  db: DbClient,
  bookingId: string,
  targetStatus: BookingStatus,
): Promise<TransitionBookingStatusResult> {
  try {
    await db.query('BEGIN');

    const { rows } = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM bookings WHERE id = $1 FOR UPDATE`,
      [bookingId],
    );
    const booking = rows[0];
    if (!booking) {
      await db.query('ROLLBACK');
      return { outcome: 'not_found' };
    }

    const currentStatus = booking.status as BookingStatus;
    if (!isAllowedTransition(currentStatus, targetStatus)) {
      await db.query('ROLLBACK');
      return { outcome: 'invalid_transition', from: currentStatus, to: targetStatus };
    }

    await db.query(`UPDATE bookings SET status = $2 WHERE id = $1`, [bookingId, targetStatus]);

    if (confirmsAllocationOnTransition(targetStatus)) {
      // Reuses payment-repository.ts's writer rather than duplicating its SQL — see this
      // function's doc comment. Idempotent/no-op on any allocation not currently 'hold' (e.g.
      // already 'confirmed'), same as when a successful payment calls it.
      await confirmBookingAllocations(db, bookingId);
    } else if (releasesAllocationOnTransition(targetStatus)) {
      await db.query(
        `UPDATE booking_allocations
         SET allocation_status = 'released', hold_expires_at = NULL
         WHERE booking_id = $1 AND allocation_status IN ('hold', 'confirmed')`,
        [bookingId],
      );
    }

    await db.query('COMMIT');
    return { outcome: 'ok', id: bookingId, status: targetStatus };
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  }
}
