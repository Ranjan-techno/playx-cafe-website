import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSE_TIME,
  GRAND_OPENING_DATE,
  GRAND_OPENING_TIME,
  OPEN_TIME,
  dayOfWeekUtc,
  effectiveOpenTime,
  parseTimeToMinutes,
  validateBookingSchedule,
} from './opening-hours';

// Grand Opening launch restriction: Play X Cafe opens 2026-09-25 at 15:00 IST. Every date used
// below is comfortably in the future relative to whenever this suite actually runs (see
// todayInIst()'s "past date" check, which none of these scenarios are meant to exercise), so these
// assertions don't depend on "today" the way a past-date test would have to.

test('sanity: the Grand Opening constants are what the business rule specifies', () => {
  assert.equal(GRAND_OPENING_DATE, '2026-09-25');
  assert.equal(GRAND_OPENING_TIME, '15:00');
  // Also confirms 25 Sep 2026 is not itself a Monday, so the launch-date and Monday-closed rules
  // never fight over the same day.
  assert.notEqual(dayOfWeekUtc(2026, 9, 25), 1);
});

test('2026-09-24 (the day before launch): every startTime is rejected as not_yet_open', () => {
  const violation = validateBookingSchedule('2026-09-24', '11:00', 60);
  assert.equal(violation?.code, 'not_yet_open');

  // Even the last possible slot of the day is still rejected — the whole day is closed, not just
  // "before some time".
  const lastSlot = validateBookingSchedule('2026-09-24', '22:00', 60);
  assert.equal(lastSlot?.code, 'not_yet_open');
});

test('2026-09-25 14:45 (before the 3pm launch time): rejected as invalid_time', () => {
  const violation = validateBookingSchedule('2026-09-25', '14:45', 15);
  assert.equal(violation?.code, 'invalid_time');
});

test('2026-09-25 15:00 (the launch moment itself): passes schedule validation', () => {
  const violation = validateBookingSchedule('2026-09-25', '15:00', 60);
  assert.equal(violation, null);
});

test('2026-09-25 15:00 remains bookable right up to closing, same as any other day', () => {
  // 15:00 + 60min finishes well before 23:00 close.
  assert.equal(validateBookingSchedule('2026-09-25', '15:00', 60), null);
  // 22:00 + 60min finishes exactly at 23:00 close — still valid.
  assert.equal(validateBookingSchedule('2026-09-25', '22:00', 60), null);
  // 22:15 + 60min would finish after close — invalid, same normal-hours rule as any other day.
  assert.equal(validateBookingSchedule('2026-09-25', '22:15', 60)?.code, 'invalid_time');
});

test('2026-09-26 (the day after launch): normal 11:00-23:00 operating hours apply', () => {
  assert.equal(validateBookingSchedule('2026-09-26', '11:00', 30), null);
  // Before the normal 11:00 open — same as any pre-launch-era date — is still rejected.
  assert.equal(validateBookingSchedule('2026-09-26', '10:45', 30)?.code, 'invalid_time');
});

test('Monday 2026-09-28 (after launch): the existing Monday closure still applies', () => {
  assert.equal(dayOfWeekUtc(2026, 9, 28), 1, 'sanity check: 2026-09-28 is a Monday');
  const violation = validateBookingSchedule('2026-09-28', '15:00', 30);
  assert.equal(violation?.code, 'closed');
});

test('direct POST /bookings cannot bypass the launch restriction: validateBookingSchedule rejects it independent of any client-supplied field', () => {
  // create-booking.ts calls validateBookingSchedule(body.bookingDate, body.startTime, ...)
  // unconditionally, before ever touching simulator allocation — there is no code path that skips
  // it, so exercising the function directly with attacker-controlled-looking input is equivalent
  // to exercising the handler's own enforcement.
  assert.equal(validateBookingSchedule('2026-09-24', '11:00', 15)?.code, 'not_yet_open');
  assert.equal(validateBookingSchedule('2026-09-25', '00:00', 15)?.code, 'invalid_time');
});

test('effectiveOpenTime: normal days keep the usual OPEN_TIME', () => {
  assert.equal(effectiveOpenTime('2026-09-26'), OPEN_TIME);
  assert.equal(effectiveOpenTime('2026-01-01'), OPEN_TIME);
});

test('effectiveOpenTime: the Grand Opening date itself returns GRAND_OPENING_TIME', () => {
  assert.equal(effectiveOpenTime('2026-09-25'), GRAND_OPENING_TIME);
});

test('effectiveOpenTime: a malformed date falls back to OPEN_TIME rather than throwing', () => {
  assert.equal(effectiveOpenTime('not-a-date'), OPEN_TIME);
});

// GET /availability's slot enumeration (backend/src/lib/simulator-allocation.ts's
// computeAvailableSlots) is driven by parseTimeToMinutes(effectiveOpenTime(date)) as its
// openMinutes bound (see availability.ts) — confirms that combination actually yields 15:00 as the
// first minute of the Grand Opening day's bookable window, and 11:00 on every other day.
test('parseTimeToMinutes(effectiveOpenTime(...)) is the 15:00 bound GET /availability enumerates from on launch day', () => {
  assert.equal(parseTimeToMinutes(effectiveOpenTime('2026-09-25')), 15 * 60);
  assert.equal(parseTimeToMinutes(effectiveOpenTime('2026-09-26')), 11 * 60);
  assert.equal(parseTimeToMinutes(CLOSE_TIME), 23 * 60);
});
