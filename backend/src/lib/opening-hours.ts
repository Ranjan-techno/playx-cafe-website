// Story 2.6: Play X opening hours business rules — Tuesday-Sunday, 11:00-23:00, Monday closed.
//
// No timezone library: IST (Asia/Kolkata) is a fixed UTC+5:30 offset with no DST, so "today in
// IST" and IST<->UTC conversions are done by shifting a UTC timestamp by 5.5 hours and reading
// UTC getters off the shifted value — simpler than pulling in a timezone library, and avoids
// depending on the Lambda runtime's ICU/tz data being complete.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const OPEN_TIME = '11:00';
const CLOSE_TIME = '23:00';

export interface OpeningHoursViolation {
  code: 'invalid_date' | 'closed' | 'invalid_time';
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

interface DateParts {
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
 * (Tuesday-Sunday 11:00-23:00, Monday closed) and the product's duration:
 *   - date must not be before IST "today" (a same-day booking for a later time today is fine —
 *     the story only asks to reject *past dates*, not a start time that has already elapsed
 *     today, so that's deliberately not checked here).
 *   - date's day-of-week must not be Monday.
 *   - startTime must be >= "11:00".
 *   - startTime + durationMinutes must be <= "23:00" (the session must finish before closing).
 * Returns null if valid, otherwise the first violation found, checked in that order.
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

  if (dayOfWeekUtc(dateParts.year, dateParts.month, dateParts.day) === 1) {
    return { code: 'closed', message: 'Play X is closed on Mondays' };
  }

  let startMinutes: number;
  try {
    startMinutes = parseTimeToMinutes(startTime);
  } catch {
    return { code: 'invalid_time', message: 'startTime must be in 24-hour HH:MM format' };
  }

  const openMinutes = parseTimeToMinutes(OPEN_TIME);
  const closeMinutes = parseTimeToMinutes(CLOSE_TIME);
  if (startMinutes < openMinutes || startMinutes + durationMinutes > closeMinutes) {
    return {
      code: 'invalid_time',
      message: `startTime must be between ${OPEN_TIME} and ${CLOSE_TIME}, and the session must finish by ${CLOSE_TIME}`,
    };
  }

  return null;
}
