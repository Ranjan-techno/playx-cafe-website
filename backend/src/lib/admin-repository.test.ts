import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminBookingDetail,
  buildDashboardSummary,
  buildSimulatorBoard,
  describePaymentReviewReason,
  getAdminBookingDetail,
  getDashboardSummary,
  listAdminBookings,
  summarizeCollectedPayments,
  encodeCursor,
  isValidUuid,
  mapAdminBookingListRow,
  mapAdminPaymentListRow,
  parseAdminBookingsQuery,
  parseAdminPaymentsQuery,
  parseBookingNumberSearch,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from './admin-repository';

// Phase 3B: the pure, DB-free half of the /admin/* domain layer — same split as
// simulator-allocation.ts (pure) vs allocate-simulators.ts (DB-touching), so query validation and
// row-shaping are unit-testable without a database. See admin-status-transition.test.ts for the
// one function here (transitionBookingStatus) that genuinely needs a fake DB to prove its
// transactional behavior.

// ----------------------------------------------------------------------------
// GET /admin/bookings query parsing
// ----------------------------------------------------------------------------

test('parseAdminBookingsQuery: no params defaults to the default page size, no filters', () => {
  const result = parseAdminBookingsQuery(undefined);
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.query, { date: undefined, status: undefined, search: undefined, limit: DEFAULT_PAGE_SIZE, cursor: undefined });
  }
});

test('parseAdminBookingsQuery: rejects a malformed date', () => {
  const result = parseAdminBookingsQuery({ date: '10-09-2026' });
  assert.equal(result.ok, false);
});

test('parseAdminBookingsQuery: rejects a status not in the real booking_status enum', () => {
  const result = parseAdminBookingsQuery({ status: 'checked_in' });
  assert.equal(result.ok, false);
});

test('parseAdminBookingsQuery: accepts a real booking_status value', () => {
  const result = parseAdminBookingsQuery({ status: 'confirmed' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.query.status, 'confirmed');
  }
});

test('parseAdminBookingsQuery: trims search, empty-after-trim search is dropped', () => {
  const result = parseAdminBookingsQuery({ search: '  Priya  ' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.query.search, 'Priya');
  }
  const empty = parseAdminBookingsQuery({ search: '   ' });
  assert.ok(empty.ok);
  if (empty.ok) {
    assert.equal(empty.query.search, undefined);
  }
});

test('parseAdminBookingsQuery: search over the max length is rejected', () => {
  const result = parseAdminBookingsQuery({ search: 'a'.repeat(101) });
  assert.equal(result.ok, false);
});

test('parseAdminBookingsQuery: limit is bounded to MAX_PAGE_SIZE even if a caller asks for more', () => {
  const result = parseAdminBookingsQuery({ limit: '99999' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.query.limit, MAX_PAGE_SIZE);
  }
});

test('parseAdminBookingsQuery: non-positive/non-integer limit is rejected', () => {
  assert.equal(parseAdminBookingsQuery({ limit: '0' }).ok, false);
  assert.equal(parseAdminBookingsQuery({ limit: '-5' }).ok, false);
  assert.equal(parseAdminBookingsQuery({ limit: 'abc' }).ok, false);
  assert.equal(parseAdminBookingsQuery({ limit: '1.5' }).ok, false);
});

test('parseAdminBookingsQuery: malformed cursor is rejected, not silently ignored', () => {
  assert.equal(parseAdminBookingsQuery({ cursor: 'not-valid-base64url-json' }).ok, false);
});

test('parseAdminBookingsQuery: a well-formed cursor round-trips through encodeCursor', () => {
  const cursor = { createdAt: '2026-09-10T12:00:00.000Z', id: 'booking-1' };
  const result = parseAdminBookingsQuery({ cursor: encodeCursor(cursor) });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.query.cursor, cursor);
  }
});

test('parseAdminBookingsQuery: cursor with a non-parseable createdAt is rejected', () => {
  const forged = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'x' }), 'utf8').toString('base64url');
  assert.equal(parseAdminBookingsQuery({ cursor: forged }).ok, false);
});

// ----------------------------------------------------------------------------
// GET /admin/payments query parsing
// ----------------------------------------------------------------------------

test('parseAdminPaymentsQuery: rejects a status outside the real payment_status enum', () => {
  assert.equal(parseAdminPaymentsQuery({ status: 'invalid' }).ok, false);
});

test('parseAdminPaymentsQuery: accepts every real payment_status value', () => {
  for (const status of ['created', 'pending', 'paid', 'failed', 'expired', 'refunded']) {
    assert.equal(parseAdminPaymentsQuery({ status }).ok, true);
  }
});

test('parseAdminPaymentsQuery: rejects a non-UUID bookingId', () => {
  assert.equal(parseAdminPaymentsQuery({ bookingId: 'not-a-uuid' }).ok, false);
});

test('parseAdminPaymentsQuery: accepts a well-formed UUID bookingId', () => {
  const result = parseAdminPaymentsQuery({ bookingId: '11111111-2222-3333-4444-555555555555' });
  assert.ok(result.ok);
});

test('isValidUuid: rejects SQL-injection-shaped and other garbage input', () => {
  assert.equal(isValidUuid("1' OR '1'='1"), false);
  assert.equal(isValidUuid('11111111-2222-3333-4444-555555555555'), true);
});

// ----------------------------------------------------------------------------
// GET /admin/bookings — search-by-4-digit-booking-number extension
// ----------------------------------------------------------------------------

test('parseBookingNumberSearch: a real 4-digit booking number in range parses to a number', () => {
  assert.equal(parseBookingNumberSearch('1007'), 1007);
  assert.equal(parseBookingNumberSearch('1001'), 1001);
  assert.equal(parseBookingNumberSearch('9999'), 9999);
});

test('parseBookingNumberSearch: below 1001 or non-4-digit input is not a booking number search', () => {
  assert.equal(parseBookingNumberSearch('1000'), null); // below the real range
  assert.equal(parseBookingNumberSearch('123'), null); // too short
  assert.equal(parseBookingNumberSearch('12345'), null); // too long
  assert.equal(parseBookingNumberSearch('Priya'), null); // a name, the existing search behavior
  assert.equal(parseBookingNumberSearch('priya@example.com'), null); // an email
});

// ----------------------------------------------------------------------------
// Row shaping (pure) — bookings list, payments list
// ----------------------------------------------------------------------------

test('mapAdminBookingListRow: shapes a full row, including allocated simulator codes and payment summary', () => {
  const item = mapAdminBookingListRow({
    id: 'booking-1',
    booking_number: 1007,
    customer_name: 'Priya Sharma',
    customer_phone: '+919876543210',
    customer_email: 'priya@example.com',
    product_code: 'solo-pro-static',
    product_name: 'Solo Racing Xperience — Pro Race (Static)',
    scheduled_start_at: new Date('2026-09-10T12:30:00.000Z'), // 18:00 IST
    scheduled_end_at: new Date('2026-09-10T13:00:00.000Z'),
    duration_minutes: 30,
    price_inr: '599.00',
    status: 'confirmed',
    created_at: new Date('2026-09-10T10:00:00.000Z'),
    simulator_codes: ['S1'],
    latest_payment_status: 'paid',
    latest_payment_provider: 'phonepe',
  });
  assert.equal(item.date, '2026-09-10');
  assert.equal(item.time, '18:00');
  assert.equal(item.priceInr, 599);
  assert.deepEqual(item.allocatedSimulators, ['S1']);
  assert.deepEqual(item.payment, { status: 'paid', provider: 'phonepe' });
  assert.equal(item.bookingReference, 'booking-1');
  assert.equal(item.bookingNumber, 1007);
});

test('mapAdminBookingListRow: no allocation rows -> empty array, no payment attempt -> null', () => {
  const item = mapAdminBookingListRow({
    id: 'booking-2',
    booking_number: 1008,
    customer_name: null,
    customer_phone: null,
    customer_email: null,
    product_code: 'solo-pro-static',
    product_name: 'Solo Racing Xperience — Pro Race (Static)',
    scheduled_start_at: new Date('2026-09-10T12:30:00.000Z'),
    scheduled_end_at: new Date('2026-09-10T13:00:00.000Z'),
    duration_minutes: 30,
    price_inr: '599.00',
    status: 'pending',
    created_at: new Date('2026-09-10T10:00:00.000Z'),
    simulator_codes: null,
    latest_payment_status: null,
    latest_payment_provider: null,
  });
  assert.deepEqual(item.allocatedSimulators, []);
  assert.equal(item.payment, null);
});

test('mapAdminPaymentListRow: never surfaces metadata (there is no field for it)', () => {
  const item = mapAdminPaymentListRow({
    id: 'payment-1',
    booking_id: 'booking-1',
    booking_number: 1007,
    provider: 'phonepe',
    provider_order_id: 'order-1',
    provider_transaction_id: 'txn-1',
    amount_inr: '599.00',
    currency: 'INR',
    payment_status: 'paid',
    failure_reason: null,
    created_at: new Date('2026-09-10T10:00:00.000Z'),
    paid_at: new Date('2026-09-10T10:05:00.000Z'),
  });
  assert.equal('metadata' in item, false);
  assert.equal(item.amountInr, 599);
  assert.equal(item.paidAt, '2026-09-10T10:05:00.000Z');
  assert.equal(item.bookingNumber, 1007);
});

// ----------------------------------------------------------------------------
// GET /admin/dashboard shaping
// ----------------------------------------------------------------------------

const NOW = new Date('2026-09-10T12:00:00.000Z');

test('buildDashboardSummary: revenue comes only from the pre-summed PAID amount, never derived from unpaid/failed counts', () => {
  const summary = buildDashboardSummary(
    '2026-09-10',
    [
      { status: 'pending', count: '3' },
      { status: 'confirmed', count: '5' },
      { status: 'cancelled', count: '1' },
    ],
    [
      { payment_status: 'paid', count: '5' },
      { payment_status: 'created', count: '2' },
      { payment_status: 'pending', count: '1' },
      { payment_status: 'failed', count: '2' },
      { payment_status: 'expired', count: '1' },
    ],
    12345, // paidRevenueInr — the pre-summed value from the database, not recomputed here
    [
      { simulator_type: 'static', count: '2' },
      { simulator_type: 'motion', count: '2' },
    ],
    [],
    NOW,
  );

  assert.equal(summary.date, '2026-09-10');
  assert.deepEqual(summary.bookings, { total: 9, confirmed: 5, pending: 3, cancelled: 1 });
  assert.deepEqual(summary.payments, { paid: 5, pending: 3, failed: 3 });
  assert.deepEqual(summary.revenue, { paidInr: 12345 });
  assert.deepEqual(summary.simulators, { total: 4, static: 2, motion: 2 });
});

test('buildDashboardSummary: no data for the day -> every bucket is zero, never undefined/NaN', () => {
  const summary = buildDashboardSummary(
    '2026-09-11',
    [],
    [],
    0,
    [
      { simulator_type: 'static', count: '2' },
      { simulator_type: 'motion', count: '2' },
    ],
    [],
    NOW,
  );
  assert.deepEqual(summary.bookings, { total: 0, confirmed: 0, pending: 0, cancelled: 0 });
  assert.deepEqual(summary.holds, { active: 0, expired: 0 });
  assert.deepEqual(summary.payments, { paid: 0, pending: 0, failed: 0 });
  assert.deepEqual(summary.revenue, { paidInr: 0 });
});

// ----------------------------------------------------------------------------
// GET /admin/dashboard shaping — Issue 2: holds.active/expired, not every 'pending' booking
// ----------------------------------------------------------------------------

test('buildDashboardSummary: a HOLD with hold_expires_at in the future counts as active', () => {
  const summary = buildDashboardSummary(
    '2026-09-10',
    [],
    [],
    0,
    [],
    [{ booking_id: 'booking-1', hold_expires_at: new Date('2026-09-10T12:10:00.000Z') }], // 10 min after NOW
    NOW,
  );
  assert.deepEqual(summary.holds, { active: 1, expired: 0 });
});

test('buildDashboardSummary: a HOLD with hold_expires_at in the past does not count as active', () => {
  const summary = buildDashboardSummary(
    '2026-09-10',
    [],
    [],
    0,
    [],
    [{ booking_id: 'booking-1', hold_expires_at: new Date('2026-09-10T11:50:00.000Z') }], // 10 min before NOW
    NOW,
  );
  assert.deepEqual(summary.holds, { active: 0, expired: 1 });
});

test('buildDashboardSummary: a booking with multiple HOLD allocations (Duo/Grand Race) counts as one active hold, not one per simulator', () => {
  const summary = buildDashboardSummary(
    '2026-09-10',
    [],
    [],
    0,
    [],
    [
      { booking_id: 'booking-duo', hold_expires_at: new Date('2026-09-10T12:10:00.000Z') },
      { booking_id: 'booking-duo', hold_expires_at: new Date('2026-09-10T12:10:00.000Z') },
    ],
    NOW,
  );
  assert.deepEqual(summary.holds, { active: 1, expired: 0 });
});

test('buildDashboardSummary: active and expired holds from different bookings are both counted, independently', () => {
  const summary = buildDashboardSummary(
    '2026-09-10',
    [],
    [],
    0,
    [],
    [
      { booking_id: 'booking-active-1', hold_expires_at: new Date('2026-09-10T12:10:00.000Z') },
      { booking_id: 'booking-active-2', hold_expires_at: new Date('2026-09-10T12:15:00.000Z') },
      { booking_id: 'booking-expired-1', hold_expires_at: new Date('2026-09-10T11:00:00.000Z') },
    ],
    NOW,
  );
  assert.deepEqual(summary.holds, { active: 2, expired: 1 });
});

test('buildDashboardSummary: bookings.pending is a booking-lifecycle count, independent from holds.active/expired', () => {
  // A pending booking whose HOLD has already expired: bookings.pending still counts it (the
  // booking row itself hasn't changed), but holds.active must not, since it no longer blocks a
  // simulator — see Issue 2.
  const summary = buildDashboardSummary(
    '2026-09-10',
    [{ status: 'pending', count: '1' }],
    [],
    0,
    [],
    [{ booking_id: 'booking-1', hold_expires_at: new Date('2026-09-10T11:00:00.000Z') }],
    NOW,
  );
  assert.equal(summary.bookings.pending, 1);
  assert.deepEqual(summary.holds, { active: 0, expired: 1 });
});

// ----------------------------------------------------------------------------
// GET /admin/bookings/{id} shaping
// ----------------------------------------------------------------------------

const BOOKING_DETAIL_ROW = {
  id: 'booking-1',
  booking_number: 1007,
  customer_name: 'Priya Sharma',
  customer_phone: '+919876543210',
  customer_email: 'priya@example.com',
  product_code: 'solo-pro-static',
  product_name: 'Solo Racing Xperience — Pro Race (Static)',
  racers: 1,
  duration_minutes: 30,
  simulator_type: 'static',
  price_inr: '599.00',
  status: 'confirmed',
  scheduled_start_at: new Date('2026-09-10T12:30:00.000Z'),
  scheduled_end_at: new Date('2026-09-10T13:00:00.000Z'),
  notes: null,
  created_at: new Date('2026-09-10T10:00:00.000Z'),
  updated_at: new Date('2026-09-10T10:05:00.000Z'),
};

test('buildAdminBookingDetail: currentPaymentStatus prefers a paid attempt over a later irrelevant one', () => {
  const detail = buildAdminBookingDetail(
    BOOKING_DETAIL_ROW,
    [
      {
        simulator_code: 'S1',
        simulator_type: 'static',
        scheduled_start_at: new Date('2026-09-10T12:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T13:00:00.000Z'),
        allocation_status: 'confirmed',
        hold_expires_at: null,
      },
    ],
    [
      // Most-recent-first, as getAdminBookingDetail's query returns it: a failed retry that
      // happened to be recorded after the paid one must not shadow it.
      {
        id: 'payment-2',
        provider: 'phonepe',
        provider_order_id: 'order-2',
        provider_transaction_id: null,
        amount_inr: '599.00',
        currency: 'INR',
        payment_status: 'failed',
        failure_reason: 'stale retry',
        created_at: new Date('2026-09-10T11:00:00.000Z'),
        paid_at: null,
      },
      {
        id: 'payment-1',
        provider: 'phonepe',
        provider_order_id: 'order-1',
        provider_transaction_id: 'txn-1',
        amount_inr: '599.00',
        currency: 'INR',
        payment_status: 'paid',
        failure_reason: null,
        created_at: new Date('2026-09-10T10:30:00.000Z'),
        paid_at: new Date('2026-09-10T10:35:00.000Z'),
      },
    ],
  );

  assert.equal(detail.currentPaymentStatus, 'paid');
  assert.equal(detail.allocations.length, 1);
  assert.equal(detail.allocations[0].simulatorCode, 'S1');
  assert.equal(detail.payments.length, 2);
  assert.equal(detail.bookingNumber, 1007);
});

test('buildAdminBookingDetail: no payment attempts -> currentPaymentStatus is null, not a crash', () => {
  const detail = buildAdminBookingDetail({ ...BOOKING_DETAIL_ROW, status: 'pending' }, [], []);
  assert.equal(detail.currentPaymentStatus, null);
  assert.deepEqual(detail.payments, []);
  assert.deepEqual(detail.allocations, []);
});

// ----------------------------------------------------------------------------
// GET /admin/simulators shaping
// ----------------------------------------------------------------------------

test('buildSimulatorBoard: returns all four rigs even when only some have entries', () => {
  const board = buildSimulatorBoard(
    [
      { id: 'sim-s1', code: 'S1', simulator_type: 'static' },
      { id: 'sim-s2', code: 'S2', simulator_type: 'static' },
      { id: 'sim-m1', code: 'M1', simulator_type: 'motion' },
      { id: 'sim-m2', code: 'M2', simulator_type: 'motion' },
    ],
    [
      {
        booking_id: 'booking-1',
        booking_number: 1001,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T05:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T06:00:00.000Z'),
        allocation_status: 'confirmed',
        hold_expires_at: null,
        booking_status: 'confirmed',
      },
    ],
    NOW,
  );

  assert.deepEqual(
    board.map((s) => s.code),
    ['S1', 'S2', 'M1', 'M2'],
  );
  assert.equal(board.find((s) => s.code === 'S1')?.entries.length, 1);
  assert.equal(board.find((s) => s.code === 'S2')?.entries.length, 0);
  assert.equal(board.find((s) => s.code === 'S1')?.entries[0].bookingNumber, 1001);
});

test('buildSimulatorBoard: an expired hold is shown as-is (hold status, past hold_expires_at) — not silently hidden or relabeled', () => {
  const board = buildSimulatorBoard(
    [{ id: 'sim-s1', code: 'S1', simulator_type: 'static' }],
    [
      {
        booking_id: 'booking-1',
        booking_number: 1001,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T05:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T06:00:00.000Z'),
        allocation_status: 'hold',
        hold_expires_at: new Date('2020-01-01T00:00:00.000Z'), // long expired
        booking_status: 'pending',
      },
    ],
    NOW,
  );
  const entry = board[0].entries[0];
  assert.equal(entry.allocationStatus, 'hold');
  assert.equal(entry.holdExpiresAt, '2020-01-01T00:00:00.000Z');
});

test('buildSimulatorBoard: a released allocation stays visible with its true status, not dropped', () => {
  const board = buildSimulatorBoard(
    [{ id: 'sim-s1', code: 'S1', simulator_type: 'static' }],
    [
      {
        booking_id: 'booking-1',
        booking_number: 1001,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T05:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T06:00:00.000Z'),
        allocation_status: 'released',
        hold_expires_at: null,
        booking_status: 'cancelled',
      },
    ],
    NOW,
  );
  assert.equal(board[0].entries[0].allocationStatus, 'released');
  assert.equal(board[0].entries[0].bookingStatus, 'cancelled');
});

// ----------------------------------------------------------------------------
// GET /admin/simulators shaping — Issue 3: blocksCapacity distinguishes blocking vs non-blocking
// ----------------------------------------------------------------------------

test('buildSimulatorBoard: blocksCapacity is true for a confirmed allocation and for an active (unexpired) hold', () => {
  const board = buildSimulatorBoard(
    [{ id: 'sim-s1', code: 'S1', simulator_type: 'static' }],
    [
      {
        booking_id: 'booking-confirmed',
        booking_number: 1001,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T05:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T06:00:00.000Z'),
        allocation_status: 'confirmed',
        hold_expires_at: null,
        booking_status: 'confirmed',
      },
      {
        booking_id: 'booking-active-hold',
        booking_number: 1002,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T07:00:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T07:30:00.000Z'),
        allocation_status: 'hold',
        hold_expires_at: new Date(NOW.getTime() + 10 * 60_000),
        booking_status: 'pending',
      },
    ],
    NOW,
  );
  const entries = board[0].entries;
  assert.equal(entries.find((e) => e.bookingId === 'booking-confirmed')?.blocksCapacity, true);
  assert.equal(entries.find((e) => e.bookingId === 'booking-active-hold')?.blocksCapacity, true);
});

test('buildSimulatorBoard: blocksCapacity is false for an expired hold and for a released allocation', () => {
  const board = buildSimulatorBoard(
    [{ id: 'sim-s1', code: 'S1', simulator_type: 'static' }],
    [
      {
        booking_id: 'booking-expired-hold',
        booking_number: 1001,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T05:30:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T06:00:00.000Z'),
        allocation_status: 'hold',
        hold_expires_at: new Date(NOW.getTime() - 10 * 60_000),
        booking_status: 'pending',
      },
      {
        booking_id: 'booking-released',
        booking_number: 1002,
        simulator_id: 'sim-s1',
        scheduled_start_at: new Date('2026-09-10T07:00:00.000Z'),
        scheduled_end_at: new Date('2026-09-10T07:30:00.000Z'),
        allocation_status: 'released',
        hold_expires_at: null,
        booking_status: 'cancelled',
      },
    ],
    NOW,
  );
  const entries = board[0].entries;
  assert.equal(entries.find((e) => e.bookingId === 'booking-expired-hold')?.blocksCapacity, false);
  assert.equal(entries.find((e) => e.bookingId === 'booking-released')?.blocksCapacity, false);
});

// ----------------------------------------------------------------------------
// Refund-required payments: never revenue, surfaced safely to admin
// ----------------------------------------------------------------------------

test('summarizeCollectedPayments: a normal paid payment counts as revenue', () => {
  const s = summarizeCollectedPayments([{ payment_status: 'paid', amount_inr: '999.00', refund_required: false, payment_environment: 'PRODUCTION' }]);
  assert.deepEqual(s.revenue, { paidInr: 999 });
  assert.deepEqual(s.refundRequired, { count: 0, amountInr: 0 });
});

test('summarizeCollectedPayments: duplicate paid + refundRequired is not revenue, but is reported as refund-required', () => {
  const s = summarizeCollectedPayments([
    { payment_status: 'paid', amount_inr: '999.00', refund_required: false, payment_environment: 'PRODUCTION' },
    { payment_status: 'paid', amount_inr: '999.00', refund_required: true, payment_environment: 'PRODUCTION' }, // duplicate
  ]);
  assert.deepEqual(s.revenue, { paidInr: 999 });
  assert.deepEqual(s.refundRequired, { count: 1, amountInr: 999 });
});

test('summarizeCollectedPayments: late paid (no capacity) + refundRequired is not revenue', () => {
  const s = summarizeCollectedPayments([{ payment_status: 'paid', amount_inr: '1499.50', refund_required: true, payment_environment: 'PRODUCTION' }]);
  assert.deepEqual(s.revenue, { paidInr: 0 });
  assert.deepEqual(s.refundRequired, { count: 1, amountInr: 1499.5 });
});

test('summarizeCollectedPayments: refunded payments count as neither revenue nor refund-required; null flag is normal', () => {
  const s = summarizeCollectedPayments([
    { payment_status: 'refunded', amount_inr: '999.00', refund_required: false, payment_environment: 'PRODUCTION' },
    { payment_status: 'refunded', amount_inr: '999.00', refund_required: true, payment_environment: 'PRODUCTION' },
    { payment_status: 'paid', amount_inr: '0.10', refund_required: null, payment_environment: 'PRODUCTION' },
    { payment_status: 'paid', amount_inr: '0.20', refund_required: null, payment_environment: 'PRODUCTION' },
  ]);
  assert.deepEqual(s.revenue, { paidInr: 0.3 }, 'integer-paise sum, no float noise');
  assert.deepEqual(s.refundRequired, { count: 0, amountInr: 0 });
});

test('getDashboardSummary revenue query: paid-only, keyed on paid_at, flags refundRequired', async () => {
  const queries: string[] = [];
  const db = {
    async query(sql: string) {
      queries.push(sql);
      if (/refund_required/.test(sql)) {
        return { rows: [{ payment_status: 'paid', amount_inr: '500.00', refund_required: false, payment_environment: 'PRODUCTION' }, { payment_status: 'paid', amount_inr: '500.00', refund_required: true, payment_environment: 'PRODUCTION' }] };
      }
      return { rows: [] };
    },
  };
  const summary = await getDashboardSummary(db as never, '2026-09-10');
  const revenueSql = queries.find((q) => /refund_required/.test(q))!;
  assert.match(revenueSql, /payment_status = 'paid'/);
  assert.match(revenueSql, /paid_at >= \$1/);
  assert.deepEqual(summary.revenue, { paidInr: 500 });
  assert.deepEqual(summary.refundRequired, { count: 1, amountInr: 500 });
});

test('describePaymentReviewReason: whitelisted wording; unknown/arbitrary metadata text never passes through', () => {
  assert.equal(describePaymentReviewReason('duplicate_payment_booking_already_paid'), 'Duplicate payment (booking already paid)');
  assert.equal(describePaymentReviewReason('hold_expired_capacity_unavailable'), 'Paid after reservation expired / capacity unavailable');
  assert.equal(describePaymentReviewReason('booking_cancelled'), 'Paid after booking was cancelled');
  assert.equal(describePaymentReviewReason('{"raw":"provider payload secret"}'), 'Refund required');
  assert.equal(describePaymentReviewReason(null), 'Refund required');
});

test('mapAdminPaymentListRow: exposes typed refund-required fields with a human reason, and nothing from raw metadata', () => {
  const item = mapAdminPaymentListRow({
    id: 'p1', booking_id: 'b1', booking_number: 7, provider: 'phonepe', provider_order_id: 'o1', provider_transaction_id: 't1',
    amount_inr: '999.00', currency: 'INR', payment_status: 'paid', failure_reason: null,
    created_at: new Date('2026-09-10T10:00:00Z'), paid_at: new Date('2026-09-10T10:01:00Z'),
    refund_required: true, review_reason: 'duplicate_payment_booking_already_paid', duplicate_of_payment_id: 'p0',
    metadata: { checkout: { redirectUrl: 'https://pay.test/SECRET' } },
  } as never);
  assert.equal(item.refundRequired, true);
  assert.equal(item.reviewReason, 'Duplicate payment (booking already paid)');
  assert.equal(item.duplicateOfPaymentId, 'p0');
  assert.equal('metadata' in item, false);
  assert.equal(JSON.stringify(item).includes('SECRET'), false);
  const normal = mapAdminPaymentListRow({ id: 'p2', booking_id: 'b1', booking_number: 7, provider: 'phonepe', provider_order_id: 'o2', provider_transaction_id: null, amount_inr: '1.00', currency: 'INR', payment_status: 'paid', failure_reason: null, created_at: new Date(), paid_at: new Date(), refund_required: null, review_reason: 'anything' } as never);
  assert.equal(normal.refundRequired, false);
  assert.equal(normal.reviewReason, null);
});

// ----------------------------------------------------------------------------
// payments.payment_environment (typed column, migration 006): only PRODUCTION is real money.
// NULL/unknown is not real money (and is never SANDBOX either — the column is NOT NULL since 007).
// metadata.paymentEnvironment is never the business source of truth.
// ----------------------------------------------------------------------------

test('summarizeCollectedPayments: a SANDBOX paid payment is excluded from revenue', () => {
  const s = summarizeCollectedPayments([{ payment_status: 'paid', amount_inr: '999.00', refund_required: false, payment_environment: 'SANDBOX' }]);
  assert.deepEqual(s.revenue, { paidInr: 0 });
  assert.deepEqual(s.refundRequired, { count: 0, amountInr: 0 });
});

test('summarizeCollectedPayments: a SANDBOX refundRequired payment is excluded from real refund exposure', () => {
  const s = summarizeCollectedPayments([
    { payment_status: 'paid', amount_inr: '999.00', refund_required: true, payment_environment: 'SANDBOX' },
    { payment_status: 'paid', amount_inr: '500.00', refund_required: true, payment_environment: 'PRODUCTION' },
  ]);
  assert.deepEqual(s.refundRequired, { count: 1, amountInr: 500 });
  assert.deepEqual(s.revenue, { paidInr: 0 });
});

test('summarizeCollectedPayments: PRODUCTION paid counts as revenue; NULL/absent/unknown do not', () => {
  const s = summarizeCollectedPayments([
    { payment_status: 'paid', amount_inr: '999.00', refund_required: false, payment_environment: 'PRODUCTION' },
    { payment_status: 'paid', amount_inr: '250.00', refund_required: true, payment_environment: 'PRODUCTION' },
    { payment_status: 'paid', amount_inr: '100.00', refund_required: false, payment_environment: null }, // NULL (impossible after 007)
    { payment_status: 'paid', amount_inr: '100.00', refund_required: true, payment_environment: null }, // NULL (impossible after 007)
    { payment_status: 'paid', amount_inr: '100.00', refund_required: false }, // column absent
    { payment_status: 'paid', amount_inr: '100.00', refund_required: false, payment_environment: 'garbage' },
  ]);
  assert.deepEqual(s.revenue, { paidInr: 999 });
  assert.deepEqual(s.refundRequired, { count: 1, amountInr: 250 });
});

test('dashboard SQL reads the typed payment_environment column strictly (no COALESCE fallback), never metadata', async () => {
  const queries: string[] = [];
  const db = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
  await getDashboardSummary(db as never, '2026-09-10');
  for (const sql of [queries.find((q) => /refund_required/.test(q))!, queries.find((q) => /GROUP BY payment_status/.test(q))!]) {
    assert.match(sql, /\bpayment_environment = 'PRODUCTION'/);
    assert.doesNotMatch(sql, /COALESCE\(payment_environment/);
    assert.doesNotMatch(sql, /payment_environment IS NULL/);
    assert.doesNotMatch(sql, /paymentEnvironment/);
  }
  const revenueSql = queries.find((q) => /refund_required/.test(q))!;
  assert.match(revenueSql, /payment_status = 'paid'/);
  assert.match(revenueSql, /metadata ->> 'refundRequired'/);
  assert.match(revenueSql, /^\s*payment_environment$/m, 'selects the raw typed column');
});

test('admin-repository never reads metadata.paymentEnvironment for business logic', () => {
  const src = require('node:fs').readFileSync(require.resolve('./admin-repository.ts'), 'utf8') as string;
  assert.doesNotMatch(src, /metadata ->> 'paymentEnvironment'/);
});

test('admin payment rows expose only a whitelisted paymentEnvironment from the typed column', () => {
  const base = { id: 'p', booking_id: 'b', booking_number: 1, provider: 'phonepe', provider_order_id: 'o', provider_transaction_id: null, amount_inr: '1.00', currency: 'INR', payment_status: 'paid', failure_reason: null, created_at: new Date(), paid_at: new Date(), refund_required: false };
  assert.equal(mapAdminPaymentListRow({ ...base, payment_environment: 'SANDBOX' } as never).paymentEnvironment, 'SANDBOX');
  assert.equal(mapAdminPaymentListRow({ ...base, payment_environment: 'PRODUCTION' } as never).paymentEnvironment, 'PRODUCTION');
  assert.equal(mapAdminPaymentListRow({ ...base, payment_environment: '{"x":"secret"}' } as never).paymentEnvironment, null);
  assert.equal(mapAdminPaymentListRow({ ...base, payment_environment: null } as never).paymentEnvironment, null, 'NULL is no longer SANDBOX');
  assert.equal(mapAdminPaymentListRow(base as never).paymentEnvironment, null, 'absent is no longer SANDBOX');
});

test('stale/mismatched metadata never overrides the typed column', () => {
  const base = { id: 'p', booking_id: 'b', booking_number: 1, provider: 'phonepe', provider_order_id: 'o', provider_transaction_id: null, amount_inr: '1.00', currency: 'INR', payment_status: 'paid', failure_reason: null, created_at: new Date(), paid_at: new Date(), refund_required: false };
  // A row whose (stale) metadata claims SANDBOX but whose typed column says PRODUCTION, and vice versa.
  const typedProd = { ...base, payment_environment: 'PRODUCTION', metadata: { paymentEnvironment: 'SANDBOX' } };
  const typedSandbox = { ...base, payment_environment: 'SANDBOX', metadata: { paymentEnvironment: 'PRODUCTION' } };
  assert.equal(mapAdminPaymentListRow(typedProd as never).paymentEnvironment, 'PRODUCTION');
  assert.equal(mapAdminPaymentListRow(typedSandbox as never).paymentEnvironment, 'SANDBOX');
  const s = summarizeCollectedPayments([
    { ...typedProd, amount_inr: '700.00' },
    { ...typedSandbox, amount_inr: '300.00' },
  ] as never);
  assert.deepEqual(s.revenue, { paidInr: 700 });
});

test('admin booking list/detail expose bookingEnvironment from the typed column (NULL/unknown -> null)', async () => {
  const listRow = {
    id: 'b1', booking_number: 1001, customer_name: null, customer_phone: null, customer_email: null,
    product_code: 'x', product_name: 'X', scheduled_start_at: new Date('2026-09-26T10:00:00Z'), scheduled_end_at: new Date('2026-09-26T10:30:00Z'),
    duration_minutes: 30, price_inr: '1.00', status: 'pending', created_at: new Date(), simulator_codes: null,
    latest_payment_status: null, latest_payment_provider: null,
  };
  assert.equal(mapAdminBookingListRow({ ...listRow, booking_environment: 'PRODUCTION' } as never).bookingEnvironment, 'PRODUCTION');
  assert.equal(mapAdminBookingListRow({ ...listRow, booking_environment: 'SANDBOX' } as never).bookingEnvironment, 'SANDBOX');
  assert.equal(mapAdminBookingListRow({ ...listRow, booking_environment: null } as never).bookingEnvironment, null);
  assert.equal(mapAdminBookingListRow({ ...listRow, booking_environment: 'LIVE' } as never).bookingEnvironment, null);

  const queries: string[] = [];
  const db = { async query(sql: string) { queries.push(sql); return { rows: [] }; } };
  await listAdminBookings(db as never, { limit: 10 });
  await getAdminBookingDetail(db as never, '00000000-0000-4000-8000-000000000000');
  assert.match(queries[0], /b\.booking_environment/);
  assert.match(queries[1], /b\.booking_environment/);
});

// ----------------------------------------------------------------------------
// Dashboard payment counts: only typed PRODUCTION counts
// ----------------------------------------------------------------------------

function dashboardCountsFor(rows: Array<{ payment_status: string; env: string | null; metadataEnv?: string }>) {
  // Stand-in for Postgres: applies the typed-column predicate only if the SQL contains it. SQL
  // semantics: NULL = 'PRODUCTION' is not true, so a NULL row never passes.
  const db = {
    async query(sql: string) {
      if (/GROUP BY payment_status/.test(sql)) {
        const filtered = /\bpayment_environment = 'PRODUCTION'/.test(sql)
          ? rows.filter((r) => r.env === 'PRODUCTION')
          : rows;
        const counts = new Map<string, number>();
        for (const r of filtered) counts.set(r.payment_status, (counts.get(r.payment_status) ?? 0) + 1);
        return { rows: [...counts].map(([payment_status, count]) => ({ payment_status, count: String(count) })) };
      }
      return { rows: [] };
    },
  };
  return getDashboardSummary(db as never, '2026-09-10');
}

test('dashboard counts: SANDBOX paid/pending/failed/expired do not count', async () => {
  const s = await dashboardCountsFor([
    { payment_status: 'paid', env: 'SANDBOX' },
    { payment_status: 'pending', env: 'SANDBOX' },
    { payment_status: 'failed', env: 'SANDBOX' },
    { payment_status: 'expired', env: 'SANDBOX' },
  ]);
  assert.deepEqual(s.payments, { paid: 0, pending: 0, failed: 0 });
});

test('dashboard counts: only typed PRODUCTION rows count; NULL and stale metadata do not', async () => {
  const s = await dashboardCountsFor([
    { payment_status: 'paid', env: 'PRODUCTION' },
    { payment_status: 'pending', env: 'PRODUCTION' },
    { payment_status: 'failed', env: 'PRODUCTION' },
    { payment_status: 'expired', env: null },
    { payment_status: 'paid', env: null, metadataEnv: 'PRODUCTION' },
    { payment_status: 'paid', env: 'SANDBOX', metadataEnv: 'PRODUCTION' },
  ]);
  assert.deepEqual(s.payments, { paid: 1, pending: 1, failed: 1 });
});

test('admin payment/booking-detail SQL reads the duplicate_of_payment_id column, not metadata', () => {
  const src = require('node:fs').readFileSync(require.resolve('./admin-repository.ts'), 'utf8') as string;
  assert.doesNotMatch(src, /metadata ->> 'duplicateOfPaymentId'/);
  assert.match(src, /p\.duplicate_of_payment_id/);
});
