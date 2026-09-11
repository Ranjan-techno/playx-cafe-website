// Story 2.6: Play X opening hours business rules — Tuesday-Sunday, 11:00-23:00, Monday closed.
//
// No timezone library: IST (Asia/Kolkata) is a fixed UTC+5:30 offset with no DST, so "today in
// IST" and IST<->UTC conversions are done by shifting a UTC timestamp by 5.5 hours and reading
// UTC getters off the shifted value — simpler than pulling in a timezone library, and avoids
// depending on the Lambda runtime's ICU/tz data being complete.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Exported for backend/src/handlers/availability.ts, which needs the same open/close bounds to
// enumerate candidate slots for a day rather than validate one specific startTime.
export const OPEN_TIME = '11:00';
export const CLOSE_TIME = '23:00';

export interface OpeningHoursViolation {
  code: 'invalid_date' | 'closed' | 'invalid_time' | 'not_yet_open';
  message: string;
}

/** Minutes since midnight, e.g. "11:00" -> 660, "23:00" -> 1380. Throws on malformed input. */
export function parseTimeToMinutes(hhmm: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  if (!match) {
    throw new Error(`Invalid time "${hhmm}" — expected 24-hour HH:MM`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours * 60 + minutes;
}

export interface DateParts {
  year: number;
  month: number; // 1-12
  day: number;
}

/**
 * Parses a strict YYYY-MM-DD string, rejecting anything Date.UTC would otherwise silently
 * normalize (e.g. "2026-02-30", "2026-13-01"). Never uses `new Date(str)` directly, which
 * parses ambiguously depending on the runtime's local timezone. Throws on malformed input.
 */
function parseDateParts(yyyyMmDd: string): DateParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(yyyyMmDd);
  if (!match) {
    throw new Error(`Invalid date "${yyyyMmDd}" — expected YYYY-MM-DD`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day) {
    throw new Error(`Invalid date "${yyyyMmDd}"`);
  }
  return { year, month, day };
}

/**
 * Play X Cafe's Grand Opening: 25 September 2026, 3:00 PM IST. Customers may submit a booking
 * request any time before then, but the earliest bookable *session* is this date/time — see
 * validateBookingSchedule/effectiveOpenTime below for how it's enforced. This pair of constants is
 * the one place that date/time is defined on the backend; GET /availability and POST /bookings
 * both derive their launch behavior from it rather than repeating it. (The frontend's own
 * `js/script.js` mirrors the date as a display/min-date constant — it can't literally import this
 * file, being a separate no-build static site — but never invents its own bookable time list; see
 * that file's header comment.)
 */
export const GRAND_OPENING_DATE = '2026-09-25'; // YYYY-MM-DD, IST
export const GRAND_OPENING_TIME = '15:00'; // HH:MM, IST, 24-hour

const grandOpeningDateParts = parseDateParts(GRAND_OPENING_DATE);
const grandOpeningDateUtcMs = Date.UTC(
  grandOpeningDateParts.year,
  grandOpeningDateParts.month - 1,
  grandOpeningDateParts.day,
);
const grandOpeningMinutes = parseTimeToMinutes(GRAND_OPENING_TIME);

/** True if `dateParts` is exactly Play X's Grand Opening date — the one day whose bookable window
 *  starts later than every other day's (at GRAND_OPENING_TIME instead of OPEN_TIME), rather than
 *  being either fully closed (before it) or fully normal (after it). */
function isGrandOpeningDate(dateParts: DateParts): boolean {
  return Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day) === grandOpeningDateUtcMs;
}

/** True if `dateParts` falls before Play X's Grand Opening date — i.e. no session that calendar
 *  day, regardless of time, can ever be booked yet. */
function isBeforeGrandOpeningDate(dateParts: DateParts): boolean {
  return Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day) < grandOpeningDateUtcMs;
}

/** The effective opening time (as minutes-since-midnight) for `dateParts`: the normal OPEN_TIME
 *  every day, except the Grand Opening date itself, which doesn't open until GRAND_OPENING_TIME.
 *  Reusing the existing "startTime < openMinutes" bound in validateBookingSchedule below with this
 *  date-dependent value (instead of the constant OPEN_TIME) is what makes 25 Sep's 14:45
 *  unbookable and 15:00 bookable without a second, separately-maintained time check. */
function effectiveOpenMinutesForParts(dateParts: DateParts): number {
  return isGrandOpeningDate(dateParts) ? grandOpeningMinutes : parseTimeToMinutes(OPEN_TIME);
}

/**
 * The effective opening time (HH:MM, IST) for `bookingDate` — see effectiveOpenMinutesForParts
 * above for what "effective" means. Exported for availability.ts, which needs this same value both
 * as validateBookingSchedule's representative startTime (to decide whether the whole day is
 * closed) and as computeAvailableSlots' openMinutes bound (so the Grand Opening date's first
 * enumerated candidate slot is already GRAND_OPENING_TIME, never earlier). A malformed
 * `bookingDate` falls back to OPEN_TIME — validateBookingSchedule independently rejects it with
 * 'invalid_date' regardless of what representative startTime it's given.
 */
export function effectiveOpenTime(bookingDate: string): string {
  try {
    return isGrandOpeningDate(parseDateParts(bookingDate)) ? GRAND_OPENING_TIME : OPEN_TIME;
  } catch {
    return OPEN_TIME;
  }
}

/** Today's date in IST, independent of the Lambda runtime's UTC clock. */
export function todayInIst(): DateParts {
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** Day of week for a Y-M-D date: 0=Sunday ... 6=Saturday, matching Date.prototype.getUTCDay(). */
export function dayOfWeekUtc(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Splits a UTC Date (e.g. a TIMESTAMPTZ column value) into its IST wall-clock date and time
 *  parts, using the same fixed +5:30 offset as todayInIst(). */
export function toIstDateTimeParts(date: Date): { date: string; time: string } {
  const shifted = new Date(date.getTime() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hours = shifted.getUTCHours();
  const minutes = shifted.getUTCMinutes();
  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

/** Inverse of toIstDateTimeParts: given IST wall-clock date + time-of-day parts, returns the
 *  UTC Date they represent (same fixed +5:30 offset). Used to compute scheduled_start_at /
 *  scheduled_end_at for storage as TIMESTAMPTZ. */
export function istPartsToUtcDate(year: number, month: number, day: number, hours: number, minutes: number): Date {
  const wallClockAsUtcMs = Date.UTC(year, month - 1, day, hours, minutes);
  return new Date(wallClockAsUtcMs - IST_OFFSET_MS);
}

/**
 * Validates a booking's calendar date + start time against Play X's opening hours
 * (Tuesday-Sunday 11:00-23:00, Monday closed), the Grand Opening launch restriction (see
 * GRAND_OPENING_DATE/GRAND_OPENING_TIME above), and the product's duration:
 *   - date must not be before IST "today" (a same-day booking for a later time today is fine —
 *     the story only asks to reject *past dates*, not a start time that has already elapsed
 *     today, so that's deliberately not checked here).
 *   - date must not be before GRAND_OPENING_DATE.
 *   - date's day-of-week must not be Monday.
 *   - startTime must be >= "11:00" (or, on GRAND_OPENING_DATE itself, >= GRAND_OPENING_TIME).
 *   - startTime + durationMinutes must be <= "23:00" (the session must finish before closing).
 * Returns null if valid, otherwise the first violation found, checked in that order. This is the
 * server-side source of truth — GET /availability and POST /bookings both call it (directly or,
 * for availability, via effectiveOpenTime), so a direct API call can never bypass the launch
 * restriction just because it skipped the frontend's own date-picker/note.
 */
export function validateBookingSchedule(
  bookingDate: string,
  startTime: string,
  durationMinutes: number,
): OpeningHoursViolation | null {
  let dateParts: DateParts;
  try {
    dateParts = parseDateParts(bookingDate);
  } catch {
    return { code: 'invalid_date', message: 'bookingDate must be a valid calendar date in YYYY-MM-DD format' };
  }

  const bookingDateUtcMs = Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day);
  const today = todayInIst();
  const todayUtcMs = Date.UTC(today.year, today.month - 1, today.day);
  if (bookingDateUtcMs < todayUtcMs) {
    return { code: 'invalid_date', message: 'bookingDate cannot be in the past' };
  }

  // Grand Opening launch restriction (see the constants/helpers above): checked ahead of the
  // Monday-closed rule since it's the more specific "not open for business at all yet" case —
  // though for any date this actually rejects, the two never disagree (25 Sep 2026 is a Friday).
  if (isBeforeGrandOpeningDate(dateParts)) {
    return {
      code: 'not_yet_open',
      message: `Play X Cafe's Grand Opening is ${GRAND_OPENING_DATE} at ${GRAND_OPENING_TIME} IST — bookings for earlier dates aren't available yet`,
    };
  }

  if (dayOfWeekUtc(dateParts.year, dateParts.month, dateParts.day) === 1) {
    return { code: 'closed', message: 'Play X is closed on Mondays' };
  }

  let startMinutes: number;
  try {
    startMinutes = parseTimeToMinutes(startTime);
  } catch {
    return { code: 'invalid_time', message: 'startTime must be in 24-hour HH:MM format' };
  }

  // openMinutes is GRAND_OPENING_TIME instead of the usual OPEN_TIME on the Grand Opening date
  // itself (see effectiveOpenMinutesForParts) — this is what makes 25 Sep's 14:45 unbookable and
  // 15:00 bookable, with no separate launch-time check duplicating this bound.
  const openMinutes = effectiveOpenMinutesForParts(dateParts);
  const closeMinutes = parseTimeToMinutes(CLOSE_TIME);
  if (startMinutes < openMinutes || startMinutes + durationMinutes > closeMinutes) {
    const openTimeLabel = isGrandOpeningDate(dateParts) ? GRAND_OPENING_TIME : OPEN_TIME;
    return {
      code: 'invalid_time',
      message: `startTime must be between ${openTimeLabel} and ${CLOSE_TIME}, and the session must finish by ${CLOSE_TIME}`,
    };
  }

  return null;
}
