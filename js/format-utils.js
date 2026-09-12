// Shared customer-facing formatting helpers for dates, times, prices, and
// booking status - used by js/script.js (booking form + success state) and
// js/my-bookings.js (My Bookings list) so both places render a booking the
// exact same way. Pure functions, no dependencies - load this before either
// of those two files.
//
// Backend/API values stay in their existing machine-readable format
// (YYYY-MM-DD, 24-hour HH:MM) - these only ever transform a copy for
// display, never anything sent back to the API.

// Deliberately not using toLocaleDateString(): its "short month" ICU data
// renders September as "Sept" (4 letters) in some browsers/Node versions,
// not the 3-letter "Sep" Play X's customer-facing copy calls for - a fixed
// table guarantees the same output everywhere.
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "2026-09-02" -> "2 Sep 2026"
function formatDateDisplay(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const [year, month, day] = yyyyMmDd.split('-').map(Number);
  if (!year || !month || !day) return yyyyMmDd;
  return `${day} ${MONTH_ABBR[month - 1]} ${year}`;
}

// "18:00" -> "6:00 PM"
function formatTimeDisplay(hhmm) {
  if (!hhmm) return '';
  const [hourStr, minuteStr] = hhmm.split(':');
  let hour = Number(hourStr);
  if (Number.isNaN(hour) || !minuteStr) return hhmm;
  const period = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minuteStr} ${period}`;
}

function formatBookingPrice(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

// The customer-facing booking reference - a 4-digit number the backend generates and returns as
// `bookingNumber` (see backend/database/migrations/004_short_booking_number.sql and this repo's
// CLAUDE.md). This is what a customer should ever see; the UUID `id` every booking also carries
// stays internal (API calls, My Bookings lookups) and is never shown as the "normal" reference.
// Falls back to a shortened form of the UUID only if bookingNumber is ever missing (e.g. while an
// older cached response is still on screen) so the UI never renders a blank reference.
//
// Returns the FULL display string, including the word "Booking" - the operational UI standard is
// "Booking #1001", never a bare "#1001". Callers must render this string as-is and must never
// prepend their own "Booking " text in front of it, or the result reads "Booking Booking #1001".
function formatBookingReference(bookingNumber, id) {
  if (typeof bookingNumber === 'number' && Number.isFinite(bookingNumber)) {
    return `Booking #${bookingNumber}`;
  }
  if (!id) return '';
  return `Booking ${id.length > 10 ? `${id.slice(0, 8)}…` : id}`;
}

// The backend only ever returns the literal status string ('pending',
// 'confirmed', 'cancelled', 'no_show', 'completed' - see
// backend/src/handlers/create-booking.ts / list-my-bookings.ts). A new
// booking is always 'pending', but Play X can't yet confirm real-time
// simulator availability, so that specific case gets its own honest copy
// instead of the generic "Pending" - every other status just gets
// underscore->space + capitalized first letters.
function formatBookingStatus(status) {
  if (status === 'pending') return 'Pending Confirmation';
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
