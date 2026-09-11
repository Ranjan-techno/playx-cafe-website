// Mobile nav toggle
const navToggle = document.getElementById('navToggle');
const siteHeader = document.querySelector('.site-header');

navToggle.addEventListener('click', () => {
  const isOpen = siteHeader.classList.toggle('nav-open');
  navToggle.setAttribute('aria-expanded', String(isOpen));
});

document.querySelectorAll('.main-nav a').forEach(link => {
  link.addEventListener('click', () => {
    siteHeader.classList.remove('nav-open');
    navToggle.setAttribute('aria-expanded', 'false');
  });
});

// ----------------------------------------------------------------------
// Booking form: Xperience selector, Simulator selector, and the live price
// summary - all driven by js/pricing-config.js (PRICING_GROUPS,
// SIMULATOR_TYPES) so the booking form can never list a duration, racer
// count, or price the Pricing section doesn't also show.
// ----------------------------------------------------------------------

// formatBookingPrice/formatDateDisplay/formatTimeDisplay/formatBookingStatus
// come from js/format-utils.js, loaded before this file.

// Builds one option's dropdown label, e.g. "Quick Race — 15 min" or
// "Duo Xperience — 15 min — 2 Racers". Reuses the exact name/duration/racer
// copy already in js/pricing-config.js - only the ordering is assembled
// here, nothing is hardcoded.
function buildXperienceLabel(group, option) {
  if (group.kind === 'signature') {
    return `${group.name} — ${option.durationMinutes} min — ${group.racers} Racers`;
  }
  const parts = option.name.split('—').map((s) => s.trim());
  const base = parts[0];
  const suffix = parts.slice(1).join(' — ');
  return suffix ? `${base} — ${option.durationMinutes} min — ${suffix}` : `${base} — ${option.durationMinutes} min`;
}

function getSelectedGroupOption(value) {
  if (!value) return null;
  const [groupIndex, optionIndex] = value.split(':').map(Number);
  const group = PRICING_GROUPS[groupIndex];
  if (!group) return null;
  return { group, option: group.options[optionIndex] };
}

const xperienceSelect = document.getElementById('xperience');
const simulatorSelect = document.getElementById('simulator');
const bookingSummary = document.getElementById('bookingSummary');
const summaryXperience = document.getElementById('summaryXperience');
const summarySimulator = document.getElementById('summarySimulator');
const summaryDuration = document.getElementById('summaryDuration');
const summaryRacers = document.getElementById('summaryRacers');
const summaryTotal = document.getElementById('summaryTotal');
const racersField = document.getElementById('racersField');
const durationField = document.getElementById('durationField');
const totalField = document.getElementById('totalField');
const xperienceNameField = document.getElementById('xperienceNameField');
const timeSelect = document.getElementById('time');
const availabilityStatus = document.getElementById('availabilityStatus');
const availabilityRetryBtn = document.getElementById('availabilityRetryBtn');

// ----------------------------------------------------------------------
// Preferred Time (Phase 2B - real-time availability): GET /availability
// (backend/src/handlers/availability.ts) is the only source of which start
// times are actually selectable for the chosen product/date - the frontend
// never manufactures a slot itself. Play X's opening hours (11:00 AM-11:00 PM,
// closed Mondays) - and the Grand Opening launch restriction (no session
// bookable before 25 Sep 2026, 3:00 PM IST) - live only on the backend now
// (backend/src/lib/opening-hours.ts); this file just renders whatever
// `availableSlots` comes back, which is why the Grand Opening date is
// selectable in the date picker (see GRAND_OPENING_DATE/minSelectableDate
// below) but 3:00 PM as the earliest *time* on that date is never hardcoded
// here - it's simply the earliest slot GET /availability ever returns for it.
//
// Flow: whenever Xperience, Simulator, or Date changes, the previously
// selected time is cleared immediately (a stale selection must never carry
// over - see updateBookingSummary()/the xperience & date change handlers
// below) and, once productCode+date both resolve, refreshTimeSlotAvailability()
// fetches fresh availability and repopulates #time with only those slots.
// POST /bookings still independently rechecks and locks inventory at submit
// time (see submitBookingRequest()) - this is a preview, never a guarantee.
// ----------------------------------------------------------------------

// Declared at top level (not inside the block below) so the booking form's
// 'reset' handler further down can also call it to restore the starting
// state after a submission.
function setTimePlaceholder(text) {
  if (!timeSelect) return;
  timeSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = text;
  timeSelect.appendChild(placeholder);
  timeSelect.disabled = true;
  timeSelect.required = false;
}

// Hides the availability status line/retry button entirely - used whenever
// there isn't yet enough information (Xperience/Simulator/date) to check
// availability for, so no stale "no slots"/"error" copy lingers under the
// time field.
function hideAvailabilityStatus() {
  if (!availabilityStatus) return;
  availabilityStatus.hidden = true;
  availabilityStatus.classList.remove('form-error');
  availabilityStatus.textContent = '';
  if (availabilityRetryBtn) availabilityRetryBtn.hidden = true;
}

// `isError` toggles between .form-hint's dim copy (loading/informational)
// and .form-error's red, bolder copy (empty-for-this-date / API failure) -
// reuses the two classes the rest of the booking form already styles these
// states with, rather than introducing a third.
function showAvailabilityStatus(text, { isError = false, showRetry = false } = {}) {
  if (!availabilityStatus) return;
  availabilityStatus.hidden = false;
  availabilityStatus.classList.toggle('form-error', isError);
  availabilityStatus.textContent = text;
  if (availabilityRetryBtn) availabilityRetryBtn.hidden = !showRetry;
}

// Rebuilds #time from exactly the slots the backend returned - never a
// locally-generated grid. Always starts from an empty selection (per Phase
// 2B requirement 8: a time chosen for one product/date must never carry
// over to another), so this alone is enough to "clear" a previous pick.
function populateTimeSelectFromSlots(slots) {
  if (!timeSelect) return;
  timeSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = 'Select a preferred time';
  timeSelect.appendChild(placeholder);
  slots.forEach((value) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = formatTimeDisplay(value);
    timeSelect.appendChild(opt);
  });
  timeSelect.disabled = false;
  timeSelect.required = true;
}

// Resolves productCode/date from the form's current state, or null if
// there isn't yet enough to check availability for (mirrors the same
// required-field logic the submit handler and updateBookingSummary() use,
// so "not enough information yet" is judged one consistent way everywhere).
function getAvailabilityContext() {
  const selection = getSelectedGroupOption(xperienceSelect.value);
  if (!selection) return null;
  const { group } = selection;
  if (group.kind !== 'signature' && !simulatorSelect.value) return null;
  const productCode = resolveProductCode(selection, simulatorSelect.value);
  if (!productCode) return null;
  if (!dateInput || !dateInput.value || dateInput.validationMessage) return null;
  return { productCode, date: dateInput.value };
}

// Monotonic counter guarding against out-of-order responses: if the
// customer changes Xperience/Simulator/date again while a fetch is still in
// flight, that in-flight response is simply ignored once it resolves
// (checked via `mySeq === availabilityRequestSeq` below) rather than
// overwriting the newer selection's placeholder/slots.
let availabilityRequestSeq = 0;

// GET /availability?productCode=&date= - the one place that calls it.
// Fails closed (Phase 2B requirement 7): a network error or non-2xx never
// falls back to "assume available" - it always surfaces the explicit
// "couldn't check" error state with a retry, and no time becomes
// selectable until a real 200 says so.
async function refreshTimeSlotAvailability() {
  const context = getAvailabilityContext();
  const mySeq = ++availabilityRequestSeq;

  if (!context) {
    hideAvailabilityStatus();
    if (!xperienceSelect.value) {
      setTimePlaceholder('Select your Xperience first');
    } else if (simulatorSelect.disabled === false && !simulatorSelect.value) {
      setTimePlaceholder('Select Static or Motion first');
    } else {
      setTimePlaceholder('Select a date to see available times');
    }
    return;
  }

  setTimePlaceholder('Checking availability...');
  showAvailabilityStatus('Checking simulator availability...');

  try {
    const response = await fetch(
      `${AWS_CONFIG.apiBaseUrl}/availability?productCode=${encodeURIComponent(context.productCode)}&date=${encodeURIComponent(context.date)}`
    );
    const body = await response.json().catch(() => ({}));
    if (mySeq !== availabilityRequestSeq) return; // superseded by a newer selection
    if (!response.ok) throw new Error(body.message || 'Failed to load availability');

    const slots = Array.isArray(body.availableSlots) ? body.availableSlots : [];
    if (slots.length === 0) {
      setTimePlaceholder('No slots available for this date');
      showAvailabilityStatus('No simulator slots are available for this date. Please choose another date.', { isError: true });
    } else {
      populateTimeSelectFromSlots(slots);
      hideAvailabilityStatus();
    }
  } catch (err) {
    if (mySeq !== availabilityRequestSeq) return; // superseded by a newer selection
    console.error('GET /availability failed', err.message || 'unknown_error');
    setTimePlaceholder('Unable to check availability');
    showAvailabilityStatus("We couldn't check simulator availability. Please try again.", { isError: true, showRetry: true });
  }
}

if (availabilityRetryBtn) {
  availabilityRetryBtn.addEventListener('click', () => refreshTimeSlotAvailability());
}

// Declared at top level (not inside the block below) so the booking form's
// 'reset' handler further down can also call it to restore the starting
// state after a submission.
function setSimulatorPlaceholder(text) {
  simulatorSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = text;
  simulatorSelect.appendChild(placeholder);
  simulatorSelect.disabled = true;
  simulatorSelect.required = false;
}

if (xperienceSelect && simulatorSelect && typeof PRICING_GROUPS !== 'undefined') {
  PRICING_GROUPS.forEach((group, groupIndex) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.title;
    group.options.forEach((option, optionIndex) => {
      const opt = document.createElement('option');
      opt.value = `${groupIndex}:${optionIndex}`;
      opt.textContent = buildXperienceLabel(group, option);
      optgroup.appendChild(opt);
    });
    xperienceSelect.appendChild(optgroup);
  });

  // Solo and Duo: a real Static/Motion choice, sourced from SIMULATOR_TYPES.
  const setMatrixSimulatorOptions = () => {
    setSimulatorPlaceholder('Select Static or Motion');
    simulatorSelect.disabled = false;
    simulatorSelect.required = true;
    SIMULATOR_TYPES.forEach((type) => {
      const opt = document.createElement('option');
      opt.value = type.id;
      opt.textContent = type.name;
      simulatorSelect.appendChild(opt);
    });
  };

  // Grand Race: no Static/Motion choice - it uses all 4 simulators, so the
  // field is locked to a single informational option instead of being asked.
  const setGrandRaceSimulator = () => {
    simulatorSelect.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = 'all';
    opt.selected = true;
    opt.textContent = 'All 4 Simulators (Static + Motion)';
    simulatorSelect.appendChild(opt);
    simulatorSelect.disabled = true;
    simulatorSelect.required = false;
  };

  function updateBookingSummary() {
    const selection = getSelectedGroupOption(xperienceSelect.value);
    if (!selection) {
      bookingSummary.hidden = true;
      return;
    }
    const { group, option } = selection;
    const isSignature = group.kind === 'signature';
    const xperienceName = isSignature ? group.name : option.name;

    bookingSummary.hidden = false;
    summaryXperience.textContent = xperienceName;
    summaryDuration.textContent = `${option.durationMinutes} min`;
    summaryRacers.textContent = `${group.racers} ${group.racers === 1 ? 'Racer' : 'Racers'}`;
    xperienceNameField.value = xperienceName;
    durationField.value = option.durationMinutes;
    racersField.value = group.racers;
    // Duration/Xperience/Simulator just changed - always re-check availability
    // from scratch (never carry a previously selected time over to a
    // different product, per Phase 2B requirement 8).
    refreshTimeSlotAvailability();

    if (isSignature) {
      summarySimulator.textContent = 'All 4 Simulators';
      summaryTotal.textContent = formatBookingPrice(option.price);
      totalField.value = option.price;
      return;
    }

    if (!simulatorSelect.value) {
      summarySimulator.textContent = 'Select Static or Motion';
      summaryTotal.textContent = '—';
      totalField.value = '';
      return;
    }

    const simType = SIMULATOR_TYPES.find((t) => t.id === simulatorSelect.value);
    const price = simulatorSelect.value === 'motion' ? option.motionPrice : option.staticPrice;
    summarySimulator.textContent = simType ? simType.name : simulatorSelect.value;
    summaryTotal.textContent = formatBookingPrice(price);
    totalField.value = price;
  }

  xperienceSelect.addEventListener('change', () => {
    const selection = getSelectedGroupOption(xperienceSelect.value);
    if (!selection) return;
    if (selection.group.kind === 'signature') {
      setGrandRaceSimulator();
    } else {
      setMatrixSimulatorOptions();
    }
    updateBookingSummary();
  });

  simulatorSelect.addEventListener('change', updateBookingSummary);

  setSimulatorPlaceholder('Select your Xperience first');
  setTimePlaceholder('Select your Xperience first');
}

// Booking form - POST /bookings (backend/src/handlers/create-booking.ts).
// The form itself is visible to every visitor, signed in or not (guest-first
// booking funnel). The Cognito JWT authorizer on that route
// (infra/lib/constructs/api.ts) still rejects an unauthenticated request
// outright - that's unchanged - so auth is only enforced at the moment of
// submit, not by hiding the form up front. A guest who submits without a
// session gets a normalized booking draft saved to sessionStorage first (see
// PENDING_BOOKING_STORAGE_KEY/readPendingBookingDraft/
// attemptDraftAutoCompletion below) so the booking is completed for them
// automatically, with no second click, the moment they're back and signed
// in - never before. A signed-in visitor with no draft in play instead gets
// Name/Email/Phone prefilled from their Cognito ID token claims as a
// convenience (see prefillBookingFormFromClaims - never trusted for
// anything security-sensitive). Only productCode/bookingDate
// (date)/startTime (time)/notes are ever sent to the API - Name/Phone/Email
// are collected (and saved in the draft) for the venue's own contact
// purposes but aren't part of that route's request body, and price is never
// sent: the backend always looks the current price up itself from the
// products table.
const bookingForm = document.getElementById('bookingForm');
const formStatus = document.getElementById('formStatus');
const bookingResult = document.getElementById('bookingResult');
const nameInput = document.getElementById('name');
const phoneInput = document.getElementById('phone');
const emailInput = document.getElementById('email');
const notesInput = document.getElementById('notes');
const guestSubmitHint = document.getElementById('bookingGuestHint');

// ----------------------------------------------------------------------
// Reservation Review - shown in place of the booking form once it's
// submitted (Phase 1 of the guest-first flow: form -> review -> [Phase 2:
// OTP verify] -> [Phase 3: POST /bookings]). No API call happens from this
// screen itself; see beginReservationVerification() further down.
// ----------------------------------------------------------------------
const reservationReview = document.getElementById('reservationReview');
const reservationReviewStatus = document.getElementById('reservationReviewStatus');
const editReservationBtn = document.getElementById('editReservationBtn');
const reserveRaceBtn = document.getElementById('reserveRaceBtn');
const reviewNotesSection = document.getElementById('reviewNotesSection');
const reservationReviewActions = document.getElementById('reservationReviewActions');

// ----------------------------------------------------------------------
// OTP verification (Phase 2) - shown in place of reservationReviewActions
// once POST /auth/start succeeds. See beginReservationVerification()/
// showOtpVerification() further down for the flow this drives.
// ----------------------------------------------------------------------
const otpVerification = document.getElementById('otpVerification');
const otpEmailEl = document.getElementById('otpEmail');
const otpDigitInputs = Array.from(document.querySelectorAll('.otp-digit'));
const verifyOtpBtn = document.getElementById('verifyOtpBtn');
const resendOtpBtn = document.getElementById('resendOtpBtn');
const otpEditReservationBtn = document.getElementById('otpEditReservationBtn');
const otpStatus = document.getElementById('otpStatus');

// ----------------------------------------------------------------------
// Booking creation (Phase 3) - shown in place of otpVerification the instant
// POST /auth/verify succeeds. See createBookingAfterVerification()/
// showBookingCreationPanel() further down for the flow this drives.
// ----------------------------------------------------------------------
const bookingCreationPanel = document.getElementById('bookingCreationPanel');
const bookingCreationStatus = document.getElementById('bookingCreationStatus');
const retryReservationBtn = document.getElementById('retryReservationBtn');

// Namespaced so it's unambiguous in DevTools/sessionStorage what this key
// holds. Only ever holds the plain booking/contact fields built below (see
// the submit handler's draft object) plus display-only copy for the Review
// screen - never a password, Cognito token, AWS credential, or any other
// secret.
const PENDING_BOOKING_STORAGE_KEY = 'playx_pending_booking';

// Holds only the Cognito CUSTOM_AUTH challenge session between POST
// /auth/start and POST /auth/verify - { email, session, createdAt }. Never
// the OTP itself, and never a token: those only ever exist in
// `pendingAuthResult` below, in memory. Namespaced the same way as
// PENDING_BOOKING_STORAGE_KEY above.
const OTP_SESSION_STORAGE_KEY = 'playx_otp_session';

function saveOtpSession(email, session) {
  try {
    sessionStorage.setItem(OTP_SESSION_STORAGE_KEY, JSON.stringify({ email, session, createdAt: Date.now() }));
  } catch (err) {
    // sessionStorage can throw in rare private-browsing edge cases - the OTP
    // screen still works off the in-memory response either way; only "resume
    // after a reload" is lost, same tradeoff as PENDING_BOOKING_STORAGE_KEY.
  }
}

function readOtpSession() {
  const raw = sessionStorage.getItem(OTP_SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    sessionStorage.removeItem(OTP_SESSION_STORAGE_KEY);
    return null;
  }
}

function clearOtpSession() {
  sessionStorage.removeItem(OTP_SESSION_STORAGE_KEY);
}

// Holds the tokens POST /auth/verify returns, in memory only - never written
// to localStorage/sessionStorage, never logged. createBookingAfterVerification()
// (further down) reads this both as its "verification just succeeded" guard
// and as a fallback token source (the real Bearer token it prefers comes from
// CognitoAuth's own persisted session - see verifyOtpBtn's click handler).
// Reset whenever the customer backs out to edit their reservation, a fresh
// verification attempt starts, or a booking is actually created.
let pendingAuthResult = null;

function resolveProductCode(selection, simulatorValue) {
  const { group, option } = selection;
  if (group.kind === 'signature') return option.productCode;
  return simulatorValue === 'motion' ? option.motionProductCode : option.staticProductCode;
}

// The inverse of resolveProductCode() - given a `productCode` already saved
// in a booking draft, finds which Xperience dropdown option (and, for a
// matrix group, which Simulator value) produced it, so
// returnToTimeSelectionAfterConflict() below can restore the form's
// selection instead of asking the customer to redo it.
function findSelectionByProductCode(productCode) {
  for (let groupIndex = 0; groupIndex < PRICING_GROUPS.length; groupIndex++) {
    const group = PRICING_GROUPS[groupIndex];
    for (let optionIndex = 0; optionIndex < group.options.length; optionIndex++) {
      const option = group.options[optionIndex];
      if (group.kind === 'signature') {
        if (option.productCode === productCode) {
          return { groupIndex, optionIndex, simulatorValue: null };
        }
      } else if (option.staticProductCode === productCode) {
        return { groupIndex, optionIndex, simulatorValue: 'static' };
      } else if (option.motionProductCode === productCode) {
        return { groupIndex, optionIndex, simulatorValue: 'motion' };
      }
    }
  }
  return null;
}

// Phase 2B requirement 9: POST /bookings staying authoritative means a slot
// GET /availability just showed as free can still legitimately 409 if
// someone else's booking wins the race first. Rather than a generic error,
// this brings the customer back to the (still-visible, untouched) booking
// form with every other detail restored from the draft - Xperience,
// Simulator, date, and contact info - only the now-taken time cleared, and
// a fresh availability check already kicked off (via the same
// change/input events a real selection would fire) so Preferred Time only
// ever offers slots that are still genuinely open.
function returnToTimeSelectionAfterConflict(draft) {
  clearOtpSession();
  pendingAuthResult = null;
  hideOtpVerification();
  bookingCreationPanel.hidden = true;
  reservationReview.hidden = true;
  bookingForm.hidden = false;

  const match = findSelectionByProductCode(draft.productCode);
  if (match) {
    xperienceSelect.value = `${match.groupIndex}:${match.optionIndex}`;
    xperienceSelect.dispatchEvent(new Event('change'));
    if (match.simulatorValue) {
      simulatorSelect.value = match.simulatorValue;
      simulatorSelect.dispatchEvent(new Event('change'));
    }
  }
  if (nameInput) nameInput.value = draft.customerName || '';
  if (phoneInput) phoneInput.value = draft.customerPhone || '';
  if (emailInput) emailInput.value = draft.customerEmail || '';
  if (notesInput) notesInput.value = draft.notes || '';
  if (dateInput) {
    dateInput.value = draft.bookingDate || '';
    dateInput.dispatchEvent(new Event('input')); // re-validates the date and refreshes availability for it
  }

  formStatus.classList.remove('success');
  formStatus.textContent = 'That time slot was just taken by another guest. Your other details are still here - please choose a new time below.';
  bookingForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Cognito's phone_number claim is stored as E.164 (+91XXXXXXXXXX - see
// js/cognito-auth.js's normalizeIndianMobileToE164()); the booking form's
// #phone field expects the bare 10-digit number the signup form itself
// collects, so strip the +91 back off for a consistent prefill. Falls back
// to the raw value for anything that doesn't match rather than throwing.
function stripIndianE164(value) {
  const match = /^\+91(\d{10})$/.exec(value || '');
  return match ? match[1] : value;
}

// Fills Name/Phone/Email from a signed-in visitor's Cognito ID token claims,
// but only into fields that are still empty - never overwrites something the
// visitor already typed. phone_number is optional at signup, so it may be
// absent; skip it rather than prefilling "undefined".
function prefillBookingFormFromClaims(claims) {
  if (!claims) return;
  if (nameInput && !nameInput.value && claims.name) nameInput.value = claims.name;
  if (emailInput && !emailInput.value && claims.email) emailInput.value = claims.email;
  if (phoneInput && !phoneInput.value && claims.phone_number) {
    phoneInput.value = stripIndianE164(claims.phone_number);
  }
}

// Reads the pending booking draft saved before a guest was sent to log
// in/sign up (see the submit handler's token-null branch below). Returns
// null if there isn't one, or if it's corrupt (in which case the corrupt
// value is discarded rather than left around to fail again later).
function readPendingBookingDraft() {
  const raw = sessionStorage.getItem(PENDING_BOOKING_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    sessionStorage.removeItem(PENDING_BOOKING_STORAGE_KEY);
    return null;
  }
}

function clearPendingBookingDraft() {
  sessionStorage.removeItem(PENDING_BOOKING_STORAGE_KEY);
}

// The one place that actually calls POST /bookings and renders the outcome -
// used both by an already-signed-in visitor's ordinary submit
// (attemptDraftAutoCompletion) and by the passwordless OTP flow's automatic
// post-verification booking (createBookingAfterVerification), so the
// fetch/render logic only exists once. Sends exactly the fields POST
// /bookings' contract expects - productCode/bookingDate/startTime/
// customerName/customerPhone/customerEmail/notes - and nothing
// security-sensitive (never price, status, cognitoSub, or userId; the
// backend alone decides those from the product row and the caller's Cognito
// JWT). `statusEl`/`loadingText` let each caller show progress in its own
// status line (the booking form's #formStatus for attemptDraftAutoCompletion,
// #bookingCreationStatus for the OTP flow) rather than assuming one shared,
// possibly-hidden element. Never touches sessionStorage itself: each caller
// decides what "success" means for its own draft bookkeeping. Returns
// { ok: true, result } or { ok: false, error } rather than throwing, so no
// caller needs its own try/catch.
async function submitBookingRequest({
  token, productCode, bookingDate, startTime, notes,
  customerName, customerPhone, customerEmail,
  submitBtn, statusEl, loadingText
}) {
  const status = statusEl || formStatus;
  if (submitBtn) submitBtn.disabled = true;
  status.classList.remove('success');
  status.textContent = loadingText || 'Sending your booking request...';
  bookingResult.hidden = true;

  try {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        productCode, bookingDate, startTime,
        customerName, customerPhone, customerEmail,
        notes: notes || null
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      // POST /bookings independently rechecks and locks inventory itself
      // (backend/src/handlers/create-booking.ts's allocateSimulators()) - a
      // slot GET /availability showed as free a moment ago can still lose
      // that race. A 409 here means exactly that (error code
      // 'simulator_unavailable'), never a generic failure - callers use
      // `.status`/`.code` to give the customer the dedicated "just taken"
      // recovery flow (Phase 2B requirement 9) instead of a plain error.
      const err = new Error(
        response.status === 409
          ? 'That time slot was just taken by another guest. Please choose a new time.'
          : (result.message || 'Failed to create booking')
      );
      err.status = response.status;
      err.code = result.error;
      throw err;
    }

    status.textContent = '';
    // Xperience/Simulator/duration are derived from the backend's own
    // `product` code (getProductDetails(), js/product-lookup.js) - the same
    // source of truth js/my-bookings.js's list uses - never from whatever a
    // caller's own draft/form happened to have selected, so this always
    // matches what was actually booked.
    const details = typeof getProductDetails === 'function' ? getProductDetails(result.product) : {};
    document.getElementById('resultXperience').textContent = details.experienceName || getProductLabel(result.product);
    document.getElementById('resultSimulator').textContent = details.simulatorType || '';
    document.getElementById('resultDuration').textContent = details.durationMinutes ? `${details.durationMinutes} min` : '—';
    document.getElementById('resultDate').textContent = formatDateDisplay(result.date);
    document.getElementById('resultTime').textContent = formatTimeDisplay(result.time);
    // The backend's price, never the frontend's preview price - see
    // reviewPrice/summaryTotal elsewhere in this file, both explicitly
    // labeled "Preview" for exactly this reason.
    document.getElementById('resultPrice').textContent = formatBookingPrice(result.price);
    const resultStatusEl = document.getElementById('resultStatus');
    resultStatusEl.textContent = formatBookingStatus(result.status);
    resultStatusEl.className = `booking-status-pill ${result.status}`;
    const referenceEl = document.getElementById('resultReference');
    if (referenceEl) {
      if (result.id) {
        referenceEl.textContent = `Booking reference: ${result.id}`;
        referenceEl.hidden = false;
      } else {
        referenceEl.hidden = true;
      }
    }
    bookingResult.hidden = false;
    bookingResult.focus();
    bookingForm.reset();
    // Reflect the new booking in the My Bookings list (js/my-bookings.js)
    // right away instead of waiting for the visitor to reload the page.
    if (typeof refreshMyBookings === 'function') refreshMyBookings();
    return { ok: true, result };
  } catch (err) {
    console.error('POST /bookings failed', err.message || 'unknown_error');
    status.textContent = err.message || 'Something went wrong - please try again.';
    return { ok: false, error: err };
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Completes a booking that was started as a guest, now that a session
// exists - no extra click needed. This is also the fallback path if the
// passwordless flow's own automatic booking (createBookingAfterVerification,
// further down) failed and the customer reloaded before hitting Retry
// Reservation: the draft is still in sessionStorage, and the Cognito session
// installed via CognitoAuth.installPasswordlessSession() at verification
// time is still valid, so this picks the attempt back up with no fresh OTP
// needed either.
// The draft is only cleared on success; a failure leaves it in place so it
// can be retried again.
async function attemptDraftAutoCompletion(token, draft) {
  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  const outcome = await submitBookingRequest({
    token,
    productCode: draft.productCode,
    bookingDate: draft.bookingDate,
    startTime: draft.startTime,
    notes: draft.notes,
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    customerEmail: draft.customerEmail,
    submitBtn
  });
  if (outcome.ok) {
    clearPendingBookingDraft();
  } else if (outcome.error && outcome.error.status === 409) {
    // Same "slot just taken" recovery as createBookingAfterVerification()'s
    // 409 branch (Phase 2B requirement 9) - this path only differs in when
    // it runs (a signed-in visitor's draft auto-completing on page load,
    // not right after OTP verification).
    returnToTimeSelectionAfterConflict(draft);
  }
}

// Runs once per page load. A signed-in visitor with a pending draft has
// their booking completed automatically (attemptDraftAutoCompletion) - that
// takes priority over the plain claims-prefill below, since they're about to
// have the booking finished for them, not asked to fill the form again. A
// signed-in visitor with no draft gets the ordinary contact-detail prefill.
// A visitor who isn't signed in gets neither - the form and any saved draft
// are left exactly as they are.
async function initBookingFormGuestUX() {
  if (typeof CognitoAuth === 'undefined' || !CognitoAuth.isConfigured) return;

  const token = await CognitoAuth.getAccessToken();
  const draft = readPendingBookingDraft();

  if (token && draft) {
    await attemptDraftAutoCompletion(token, draft);
    return;
  }

  if (token) {
    const claims = await CognitoAuth.getIdTokenClaims();
    if (claims) {
      if (guestSubmitHint) guestSubmitHint.hidden = true;
      prefillBookingFormFromClaims(claims);
    }
  }
}

// Fills the Reservation Review screen from a saved draft (never re-read from
// the form fields, so the review always reflects exactly what was saved to
// sessionStorage). `draft.display` carries the human-readable copy
// (Xperience name, Simulator label, formatted date/time, preview price) -
// it's cached at submit time rather than recomputed here so Review still
// renders correctly even if PRICING_GROUPS' shape ever changes later.
function renderReservationReview(draft) {
  const display = draft.display || {};
  document.getElementById('reviewXperience').textContent = display.xperienceName || '';
  document.getElementById('reviewSimulator').textContent = display.simulatorType || '';
  document.getElementById('reviewDuration').textContent = display.durationMinutes ? `${display.durationMinutes} min` : '—';
  document.getElementById('reviewDate').textContent = display.dateDisplay || formatDateDisplay(draft.bookingDate);
  document.getElementById('reviewTime').textContent = display.timeDisplay || formatTimeDisplay(draft.startTime);
  document.getElementById('reviewPrice').textContent = typeof display.price === 'number' ? formatBookingPrice(display.price) : '—';
  document.getElementById('reviewName').textContent = draft.customerName || '';
  document.getElementById('reviewPhone').textContent = draft.customerPhone || '';
  document.getElementById('reviewEmail').textContent = draft.customerEmail || '';

  if (draft.notes) {
    document.getElementById('reviewNotes').textContent = draft.notes;
    reviewNotesSection.hidden = false;
  } else {
    reviewNotesSection.hidden = true;
  }
}

// Swaps the booking form out for the Reservation Review screen, showing the
// "Edit Details"/"Reserve My Race" actions rather than the OTP UI (a fresh or
// re-edited draft always starts from there, never mid-verification). The
// form is only hidden here, never reset - "Edit Details" (showBookingFormForEdit
// below) can bring it back exactly as the customer left it.
function showReservationReview(draft) {
  renderReservationReview(draft);
  reservationReviewStatus.classList.remove('success');
  reservationReviewStatus.textContent = '';
  formStatus.textContent = '';
  hideOtpVerification();
  bookingForm.hidden = true;
  reservationReview.hidden = false;
  reservationReview.focus();
}

// "Edit Details"/"Edit reservation" - back to the form, with every field
// exactly as the customer left it (nothing here touches form values, only
// visibility). Also abandons any in-flight OTP challenge: a customer who
// changes their reservation details shouldn't come back to a stale
// session/half-entered code, and the tokens from an already-completed
// verification are for the reservation as it was, not as it's about to be
// edited.
function showBookingFormForEdit() {
  clearOtpSession();
  pendingAuthResult = null;
  hideOtpVerification();
  reservationReview.hidden = true;
  bookingForm.hidden = false;
  xperienceSelect.focus();
}

editReservationBtn.addEventListener('click', showBookingFormForEdit);
otpEditReservationBtn.addEventListener('click', showBookingFormForEdit);

// ----------------------------------------------------------------------
// POST /auth/start and POST /auth/verify - the real passwordless OTP flow
// (backend/src/handlers/auth-start.ts, auth-verify.ts). Both throw a plain
// Error on failure (never the raw fetch Response) carrying the backend's
// machine-readable `error` code as `.code`, so callers can branch on it
// (e.g. "expired_session", "invalid_code") without re-parsing anything.
// Neither function - nor any caller below - ever logs the OTP, the challenge
// session, or a token: only the short `error` code, which is never secret.
// ----------------------------------------------------------------------
async function callAuthStart(email, name, phone) {
  const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/auth/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, phone })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('POST /auth/start failed', body.error || 'unknown_error');
    const err = new Error(body.message || 'Unable to send your verification code. Please try again.');
    err.code = body.error;
    throw err;
  }
  return body; // { challenge, session }
}

async function callAuthVerify(email, code, session) {
  const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, session })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('POST /auth/verify failed', body.error || 'unknown_error');
    const err = new Error(body.message || 'Unable to verify your code. Please try again.');
    err.code = body.error;
    // Only present alongside "invalid_code" - Cognito rotates the challenge
    // session on every wrong-but-not-locked-out attempt, so the caller must
    // retry with this one, never the one it just sent. Never logged above.
    err.session = body.session;
    throw err;
  }
  return body; // { idToken, accessToken, refreshToken, expiresIn }
}

// ----------------------------------------------------------------------
// OTP digit boxes - six single-character inputs standing in for one 6-digit
// field: digit-only, auto-advance on entry, backspace steps back into the
// previous (now-cleared) box once the current one is already empty, and a
// paste anywhere in the group fills every box from the pasted digits at
// once (a customer pasting a code copied from their email/SMS app).
// ----------------------------------------------------------------------
function getOtpCode() {
  return otpDigitInputs.map((input) => input.value).join('');
}

function clearOtpDigits(focusFirst) {
  otpDigitInputs.forEach((input) => { input.value = ''; });
  if (focusFirst && otpDigitInputs[0]) otpDigitInputs[0].focus();
}

otpDigitInputs.forEach((input, index) => {
  input.addEventListener('input', () => {
    // Keep only the last digit typed - covers a mobile keyboard briefly
    // showing more than one character mid-composition.
    input.value = input.value.replace(/\D/g, '').slice(-1);
    if (input.value && index < otpDigitInputs.length - 1) {
      otpDigitInputs[index + 1].focus();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !input.value && index > 0) {
      e.preventDefault();
      otpDigitInputs[index - 1].value = '';
      otpDigitInputs[index - 1].focus();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      otpDigitInputs[index - 1].focus();
    } else if (e.key === 'ArrowRight' && index < otpDigitInputs.length - 1) {
      otpDigitInputs[index + 1].focus();
    }
  });

  input.addEventListener('paste', (e) => {
    const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
    if (!pasted) return;
    e.preventDefault();
    pasted.slice(0, otpDigitInputs.length).split('').forEach((digit, i) => {
      otpDigitInputs[i].value = digit;
    });
    const lastFilledIndex = Math.min(pasted.length, otpDigitInputs.length) - 1;
    otpDigitInputs[Math.max(lastFilledIndex, 0)].focus();
  });
});

// Reveals the OTP UI in place of reservationReviewActions once POST
// /auth/start has succeeded.
function showOtpVerification(email) {
  otpEmailEl.textContent = email;
  reservationReviewActions.hidden = true;
  otpVerification.hidden = false;
  otpStatus.classList.remove('success');
  otpStatus.textContent = '';
  verifyOtpBtn.disabled = false;
  resendOtpBtn.disabled = false;
  otpEditReservationBtn.disabled = false;
  clearOtpDigits(true);
}

// Reverses showOtpVerification() - used whenever the customer backs out to
// edit their reservation (showBookingFormForEdit) or a fresh Review screen
// is shown (showReservationReview), so neither leaves stale OTP UI state
// behind for next time.
function hideOtpVerification() {
  otpVerification.hidden = true;
  bookingCreationPanel.hidden = true;
  reservationReviewActions.hidden = false;
  otpStatus.classList.remove('success');
  otpStatus.textContent = '';
  verifyOtpBtn.disabled = false;
  resendOtpBtn.disabled = false;
  otpEditReservationBtn.disabled = false;
  clearOtpDigits(false);
}

// "Reserve My Race" - starts the real passwordless OTP flow: POST
// /auth/start using the contact details already in the booking draft (never
// re-asked here), then - on success - shows the inline 6-digit code entry.
// A failure restores the button and leaves the draft/review screen exactly
// as they were (requirement: never lose the draft on a failed start).
async function beginReservationVerification(draft) {
  reserveRaceBtn.disabled = true;
  reservationReviewStatus.classList.remove('success');
  reservationReviewStatus.textContent = 'Sending code...';

  try {
    const { session } = await callAuthStart(draft.customerEmail, draft.customerName, draft.customerPhone);
    saveOtpSession(draft.customerEmail, session);
    reservationReviewStatus.textContent = '';
    showOtpVerification(draft.customerEmail);
  } catch (err) {
    reservationReviewStatus.textContent = err.message || 'Unable to send your verification code. Please try again.';
  } finally {
    reserveRaceBtn.disabled = false;
  }
}

// Reveals the "Almost There" panel in place of otpVerification and kicks off
// createBookingAfterVerification() - called once, right after a successful
// POST /auth/verify (see the click handler below), never in response to a
// second click.
function showBookingCreationPanel() {
  otpVerification.hidden = true;
  bookingCreationPanel.hidden = false;
  retryReservationBtn.hidden = true;
  retryReservationBtn.disabled = false;
  bookingCreationStatus.classList.remove('success');
  bookingCreationStatus.textContent = 'Creating your reservation...';
}

// Guards createBookingAfterVerification() against overlapping calls - e.g. a
// customer clicking Retry Reservation more than once before the first
// request returns - so at most one POST /bookings is ever in flight.
let isCreatingBooking = false;

// The automatic POST /bookings that follows a successful /auth/verify - and
// also what Retry Reservation (below) calls again on a failed attempt. Never
// re-verifies the OTP: it reads the access token from the Cognito session
// CognitoAuth.installPasswordlessSession() installed right after
// verification succeeded (falling back to the raw token /auth/verify
// returned, held in pendingAuthResult, only if that somehow didn't install),
// so a retry - even
// after a reload, via attemptDraftAutoCompletion() above - never asks the
// customer to enter a fresh code. A failed attempt leaves
// playx_pending_booking and the verified session exactly as they are;
// only a 201 clears Phase 3's own state.
async function createBookingAfterVerification(draft) {
  if (isCreatingBooking || !pendingAuthResult) return;
  isCreatingBooking = true;
  retryReservationBtn.disabled = true;
  retryReservationBtn.hidden = true;

  const token = (CognitoAuth.isConfigured && (await CognitoAuth.getAccessToken())) || pendingAuthResult.accessToken;
  const outcome = await submitBookingRequest({
    token,
    productCode: draft.productCode,
    bookingDate: draft.bookingDate,
    startTime: draft.startTime,
    notes: draft.notes,
    customerName: draft.customerName,
    customerPhone: draft.customerPhone,
    customerEmail: draft.customerEmail,
    statusEl: bookingCreationStatus,
    loadingText: 'Creating your reservation...'
  });

  isCreatingBooking = false;

  if (outcome.ok) {
    // Only now - a real 201 - is any of Phase 3's own state cleared. The
    // authenticated session itself (CognitoAuth's persisted tokens) is
    // deliberately left alone: My Bookings (js/my-bookings.js) needs it next.
    clearPendingBookingDraft();
    clearOtpSession();
    clearOtpDigits(false);
    pendingAuthResult = null;
    bookingCreationPanel.hidden = true;
    reservationReview.hidden = true;
  } else if (outcome.error && outcome.error.status === 409) {
    // Phase 2B requirement 9: the slot GET /availability showed as free was
    // taken by someone else before this POST landed - not a generic
    // failure. clearPendingBookingDraft() is deliberately skipped here (the
    // customer is about to build a fresh one the moment they resubmit with
    // a new time); pendingAuthResult/the OTP session, on the other hand, are
    // cleared inside returnToTimeSelectionAfterConflict() since resubmitting
    // goes through Review -> a fresh OTP, same as any other reservation.
    bookingCreationPanel.hidden = true;
    returnToTimeSelectionAfterConflict(draft);
  } else {
    bookingCreationStatus.classList.remove('success');
    bookingCreationStatus.textContent = "We verified your email, but couldn't create your reservation.";
    retryReservationBtn.hidden = false;
    retryReservationBtn.disabled = false;
  }
}

// "Retry Reservation" - shown only after a failed automatic booking attempt.
// Reuses the same draft and verified session; never re-asks for an OTP.
retryReservationBtn.addEventListener('click', () => {
  const draft = readPendingBookingDraft();
  if (!draft || !pendingAuthResult) {
    // Shouldn't happen in normal use - both are only cleared once a booking
    // actually succeeds - but a cleared/corrupt draft (or a session that
    // somehow never got set) shouldn't leave the customer stuck retrying
    // something that no longer exists.
    bookingCreationPanel.hidden = true;
    showBookingFormForEdit();
    formStatus.textContent = 'Your reservation details were lost - please review them again.';
    return;
  }
  createBookingAfterVerification(draft);
});

// "Verify Code" - POST /auth/verify with the entered digits and the stored
// challenge session. On success it installs the returned tokens into the
// project's existing Cognito session storage (CognitoAuth.
// installPasswordlessSession() - the same helper the My Bookings OTP flow
// below uses, backed by the same getSession()/getAccessToken() everywhere
// else in the app already reads from), tells the customer their email is
// verified, then - with no further click - moves straight into
// createBookingAfterVerification() to actually create the reservation.
verifyOtpBtn.addEventListener('click', async () => {
  const draft = readPendingBookingDraft();
  if (!draft) {
    // Shouldn't happen in normal use - the draft is only cleared once Phase
    // 3 actually creates the booking, which doesn't exist yet - but a
    // cleared/corrupt sessionStorage entry shouldn't leave the customer
    // stuck verifying a reservation that no longer exists.
    hideOtpVerification();
    showBookingFormForEdit();
    formStatus.textContent = 'Your reservation details were lost - please review them again.';
    return;
  }

  const code = getOtpCode();
  if (!/^\d{6}$/.test(code)) {
    otpStatus.classList.remove('success');
    otpStatus.textContent = 'Enter all 6 digits of the code.';
    return;
  }

  const otpSession = readOtpSession();
  if (!otpSession || otpSession.email !== draft.customerEmail) {
    otpStatus.classList.remove('success');
    otpStatus.textContent = 'This verification code has expired. Send a new code to continue.';
    return;
  }

  verifyOtpBtn.disabled = true;
  otpStatus.classList.remove('success');
  otpStatus.textContent = 'Verifying...';

  try {
    const authResult = await callAuthVerify(draft.customerEmail, code, otpSession.session);
    // In memory only - never sessionStorage/localStorage, never logged. See
    // the top-of-file declaration. Kept as a fallback token source and as
    // the "verification just succeeded" guard createBookingAfterVerification()
    // checks; the actual Bearer token it uses comes from CognitoAuth below.
    pendingAuthResult = { ...authResult, email: draft.customerEmail };
    clearOtpSession();
    // The one shared helper both OTP flows use to install a passwordless
    // /auth/verify result into the project's existing Cognito session
    // storage (see js/cognito-auth.js) - reused here rather than inventing a
    // second session mechanism. A failure here doesn't block booking
    // creation - createBookingAfterVerification() below falls back to
    // pendingAuthResult.accessToken above - but is still worth a quiet,
    // token-free warning, since it means this visitor won't stay signed in
    // past this page load (no My Bookings without a fresh code next time).
    try {
      await CognitoAuth.installPasswordlessSession(draft.customerEmail, authResult);
    } catch (installErr) {
      console.warn(
        'Passwordless session install failed:',
        installErr instanceof Error ? installErr.message : 'unknown_error'
      );
    }
    // Disable every other action on this screen - a customer clicking Resend
    // or Edit in the instant before the screen swaps below shouldn't be able
    // to interrupt a verification that already succeeded.
    resendOtpBtn.disabled = true;
    otpEditReservationBtn.disabled = true;
    otpStatus.classList.add('success');
    otpStatus.textContent = 'Email verified.';
    // No further click needed: briefly let "Email verified." register, then
    // move straight into creating the reservation.
    setTimeout(() => {
      showBookingCreationPanel();
      createBookingAfterVerification(draft);
    }, 600);
  } catch (err) {
    otpStatus.classList.remove('success');
    verifyOtpBtn.disabled = false;

    if (err.code === 'expired_session') {
      clearOtpSession();
      otpStatus.textContent = `${err.message} Send a new code to continue.`;
    } else if (err.code === 'invalid_code') {
      // Cognito rotates the challenge session on every wrong attempt -
      // replace the stored one so a retry uses the current session, never
      // the stale one that was just rejected (see callAuthVerify above).
      if (err.session) saveOtpSession(draft.customerEmail, err.session);
      otpStatus.textContent = err.message || 'The code you entered is incorrect.';
      clearOtpDigits(true);
    } else {
      otpStatus.textContent = err.message || 'Unable to verify your code. Please try again.';
    }
  }
});

// "Resend code" - calls /auth/start again and replaces the stored challenge
// session with the new one; the old session is never reused.
resendOtpBtn.addEventListener('click', async () => {
  const draft = readPendingBookingDraft();
  if (!draft) {
    hideOtpVerification();
    showBookingFormForEdit();
    formStatus.textContent = 'Your reservation details were lost - please review them again.';
    return;
  }

  resendOtpBtn.disabled = true;
  otpStatus.classList.remove('success');
  otpStatus.textContent = 'Sending a new code...';

  try {
    const { session } = await callAuthStart(draft.customerEmail, draft.customerName, draft.customerPhone);
    saveOtpSession(draft.customerEmail, session);
    clearOtpDigits(true);
    verifyOtpBtn.disabled = false;
    otpStatus.textContent = 'A new code is on its way to your email.';
  } catch (err) {
    otpStatus.textContent = err.message || 'Unable to send a new code. Please try again.';
  } finally {
    resendOtpBtn.disabled = false;
  }
});

reserveRaceBtn.addEventListener('click', () => {
  const draft = readPendingBookingDraft();
  if (!draft) {
    // Shouldn't happen in normal use (the draft is written right before this
    // screen is shown), but a cleared/corrupt sessionStorage entry shouldn't
    // leave the customer stuck on a review screen with nothing to reserve.
    reservationReviewStatus.textContent = 'Your reservation details were lost - please review them again.';
    showBookingFormForEdit();
    return;
  }
  beginReservationVerification(draft);
});

bookingForm.addEventListener('submit', (e) => {
  e.preventDefault();

  // Validate first: only ever build a draft once the form's
  // Xperience/Simulator selection actually resolves to a real product.
  // Every other required field already blocks the native 'submit' event
  // from firing at all via HTML5 constraint validation.
  const selection = getSelectedGroupOption(xperienceSelect.value);
  const productCode = selection ? resolveProductCode(selection, simulatorSelect.value) : null;
  if (!productCode) {
    formStatus.classList.remove('success');
    formStatus.textContent = 'Please select your Xperience (and Simulator, if applicable) first.';
    return;
  }

  const { group, option } = selection;
  const isSignature = group.kind === 'signature';
  const xperienceName = isSignature ? group.name : option.name;
  const simulatorType = isSignature
    ? 'All 4 Simulators'
    : ((SIMULATOR_TYPES.find((t) => t.id === simulatorSelect.value) || {}).name || simulatorSelect.value);
  const price = isSignature
    ? option.price
    : (simulatorSelect.value === 'motion' ? option.motionPrice : option.staticPrice);
  const bookingDate = document.getElementById('date').value; // native YYYY-MM-DD, no conversion needed
  const startTime = timeSelect.value; // already HH:mm - one of GET /availability's availableSlots

  // #time's `required` attribute is deliberately turned off while
  // availability is loading/erroring/empty (setTimePlaceholder()), so a
  // disabled placeholder never blocks native constraint validation - but
  // that also means native validation alone can't be trusted to catch an
  // empty selection made in that window. Guard it explicitly so Review My
  // Reservation can never proceed with a stale/missing time (Phase 2B
  // requirement 7).
  if (!startTime) {
    formStatus.classList.remove('success');
    formStatus.textContent = 'Please select an available time before continuing.';
    return;
  }

  // Normalized draft, saved under the existing PENDING_BOOKING_STORAGE_KEY.
  // productCode/bookingDate/startTime/customerName/customerPhone/
  // customerEmail/notes match POST /bookings' request body field-for-field
  // (see backend/src/handlers/create-booking.ts) so submitBookingRequest()
  // can send this draft's fields straight through once a session exists -
  // via createBookingAfterVerification() (Phase 3) or attemptDraftAutoCompletion().
  // `display` is Review-screen-only preview copy, never sent to the API and
  // never read by either of those.
  const draft = {
    productCode,
    bookingDate,
    startTime,
    customerName: nameInput.value.trim(),
    customerPhone: phoneInput.value.trim(),
    customerEmail: emailInput.value.trim(),
    notes: notesInput.value.trim() || null,
    display: {
      xperienceName,
      simulatorType,
      durationMinutes: option.durationMinutes,
      price,
      dateDisplay: formatDateDisplay(bookingDate),
      timeDisplay: formatTimeDisplay(startTime)
    }
  };

  try {
    sessionStorage.setItem(PENDING_BOOKING_STORAGE_KEY, JSON.stringify(draft));
  } catch (err) {
    // sessionStorage can throw in rare private-browsing edge cases - the
    // Review screen below still works off the in-memory draft either way;
    // only "resume where I left off after a reload" is lost.
  }

  showReservationReview(draft);
});

// bookingForm.reset() above fires a native 'reset' event - use it to put the
// Xperience-dependent Simulator field and summary back to their starting
// state too, since resetting the form doesn't do that on its own.
if (xperienceSelect && simulatorSelect) {
  bookingForm.addEventListener('reset', () => {
    setSimulatorPlaceholder('Select your Xperience first');
    setTimePlaceholder('Select your Xperience first');
    hideAvailabilityStatus();
    bookingSummary.hidden = true;
  });
}

// Set minimum bookable date to "today" in IST (Play X's timezone - Chennai),
// computed the same way as backend/src/lib/opening-hours.ts's todayInIst()
// so this can't disagree with the backend about what "today" is just
// because a visitor's device clock is in a different timezone. Also reject
// Mondays - Play X is closed that day, so a date picker with no restriction
// would let a customer request a slot that can never be honored.
const dateInput = document.getElementById('date');
const dateError = document.getElementById('dateError');
const MONDAY_MESSAGE = 'Play X is closed on Mondays. Please select another date.';
const PAST_DATE_MESSAGE = 'Please select a date from today onwards.';
// Grand Opening: 25 Sep 2026, 3:00 PM IST. Mirrors backend/src/lib/opening-hours.ts's
// GRAND_OPENING_DATE - that file is the one real source of truth (GET /availability and POST
// /bookings both enforce it server-side regardless of what this page does), but a no-build static
// site with no shared module system can't literally import it, so this constant exists to keep the
// date picker's `min` (and this validation message) from disagreeing with the backend. It only
// ever gates *which date* is selectable - never a bookable *time*, which always comes from GET
// /availability itself (see refreshTimeSlotAvailability() above), so the two can't drift on that
// half of the rule even if this constant is ever forgotten in an update.
const GRAND_OPENING_DATE = '2026-09-25';
const BEFORE_OPENING_MESSAGE = 'Play X Cafe opens 25 Sep 2026 at 3:00 PM. Please select that date or later.';

function todayIsoInIst() {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const shifted = new Date(Date.now() + IST_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

if (dateInput) {
  const todayIso = todayIsoInIst();
  // The earliest selectable date is whichever of "today" or the Grand Opening date is later -
  // once the Grand Opening date itself has passed, this naturally reverts to plain "today" with no
  // launch restriction left to apply (Play X's normal operating-hours rules take over entirely,
  // same as the backend's isBeforeGrandOpeningDate()/GRAND_OPENING_DATE compare).
  const minSelectableDate = todayIso > GRAND_OPENING_DATE ? todayIso : GRAND_OPENING_DATE;
  dateInput.setAttribute('min', minSelectableDate);

  dateInput.addEventListener('input', () => {
    if (!dateInput.value) {
      dateInput.setCustomValidity('');
      if (dateError) dateError.hidden = true;
      // No date selected - nothing to check availability for (Phase 2B
      // requirement 8: clear any previously selected time when the date
      // changes, never leave a stale one selectable).
      refreshTimeSlotAvailability();
      return;
    }
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const isMonday = new Date(y, m - 1, d).getDay() === 1;
    const isPast = dateInput.value < todayIso;
    const isBeforeOpening = dateInput.value < GRAND_OPENING_DATE;
    // Same check order as backend/src/lib/opening-hours.ts's validateBookingSchedule: past-date,
    // then the Grand Opening launch restriction, then Monday-closed.
    const message = isPast ? PAST_DATE_MESSAGE : isBeforeOpening ? BEFORE_OPENING_MESSAGE : isMonday ? MONDAY_MESSAGE : '';
    dateInput.setCustomValidity(message);
    if (dateError) {
      dateError.textContent = message;
      dateError.hidden = !message;
    }
    // A new (or newly valid/invalid) date - re-check availability from
    // scratch rather than trusting whatever was shown for the previous date.
    refreshTimeSlotAvailability();
  });
}

// ----------------------------------------------------------------------
// My Bookings - passwordless sign-in gate (Phase 4). Replaces the old
// Log In/Sign Up links to auth.html - Play X has no password login left in
// the customer-facing journey. This is the exact same POST /auth/start ->
// 6-digit OTP -> POST /auth/verify -> CognitoAuth.installPasswordlessSession()
// sequence Reserve My Race uses above, just without a booking to create
// afterward: a successful verify here goes straight to refreshMyBookings()
// (js/my-bookings.js), which is also what decides this gate's visibility in
// the first place - a customer who just completed a booking in this same
// session already has a valid installed session, so they never see it.
// ----------------------------------------------------------------------
const myBookingsGate = document.getElementById('myBookingsLoggedOut');
const myBookingsAuthForm = document.getElementById('myBookingsAuthForm');
const myBookingsEmailInput = document.getElementById('myBookingsEmail');
const myBookingsSendCodeBtn = document.getElementById('myBookingsSendCodeBtn');
const myBookingsAuthStatus = document.getElementById('myBookingsAuthStatus');
const myBookingsOtp = document.getElementById('myBookingsOtp');
const myBookingsOtpEmailEl = document.getElementById('myBookingsOtpEmail');
const myBookingsOtpDigitInputs = Array.from(document.querySelectorAll('.mb-otp-digit'));
const myBookingsVerifyBtn = document.getElementById('myBookingsVerifyBtn');
const myBookingsResendBtn = document.getElementById('myBookingsResendBtn');
const myBookingsChangeEmailBtn = document.getElementById('myBookingsChangeEmailBtn');
const myBookingsOtpStatus = document.getElementById('myBookingsOtpStatus');

if (myBookingsGate && myBookingsAuthForm) {
  // POST /auth/start (backend/src/handlers/auth-start.ts) requires a
  // non-empty name and a valid Indian phone number on every call - it uses
  // them only to create a brand-new Cognito user the first time an email
  // signs in, and ignores them entirely for an email that already has one
  // (the overwhelmingly common case here: a customer checking My Bookings
  // has almost always already booked once via Reserve My Race, which
  // supplies their real name/phone then). These placeholders are what the
  // rare case of a My-Bookings-only first sign-in gets instead - harmless,
  // since neither attribute is shown anywhere in this app besides an
  // optional prefill on the booking form.
  const MY_BOOKINGS_PLACEHOLDER_NAME = 'Play X Customer';
  const MY_BOOKINGS_PLACEHOLDER_PHONE = '0000000000';

  // Same auto-advance/backspace/paste behavior as the booking flow's
  // otpDigitInputs above, wired separately (rather than shared) so this gate
  // can't accidentally interact with that already-working flow.
  myBookingsOtpDigitInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && index < myBookingsOtpDigitInputs.length - 1) {
        myBookingsOtpDigitInputs[index + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        e.preventDefault();
        myBookingsOtpDigitInputs[index - 1].value = '';
        myBookingsOtpDigitInputs[index - 1].focus();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        myBookingsOtpDigitInputs[index - 1].focus();
      } else if (e.key === 'ArrowRight' && index < myBookingsOtpDigitInputs.length - 1) {
        myBookingsOtpDigitInputs[index + 1].focus();
      }
    });
    input.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (!pasted) return;
      e.preventDefault();
      pasted.slice(0, myBookingsOtpDigitInputs.length).split('').forEach((digit, i) => {
        myBookingsOtpDigitInputs[i].value = digit;
      });
      const lastFilledIndex = Math.min(pasted.length, myBookingsOtpDigitInputs.length) - 1;
      myBookingsOtpDigitInputs[Math.max(lastFilledIndex, 0)].focus();
    });
  });

  function getMyBookingsOtpCode() {
    return myBookingsOtpDigitInputs.map((input) => input.value).join('');
  }

  function clearMyBookingsOtpDigits(focusFirst) {
    myBookingsOtpDigitInputs.forEach((input) => { input.value = ''; });
    if (focusFirst && myBookingsOtpDigitInputs[0]) myBookingsOtpDigitInputs[0].focus();
  }

  // Holds the Cognito CUSTOM_AUTH challenge session between POST /auth/start
  // and POST /auth/verify for this gate only - kept separate from the
  // booking flow's OTP_SESSION_STORAGE_KEY/otpSession above since the two
  // verifications are otherwise unrelated. In memory only, not
  // sessionStorage: unlike a reservation draft, there's nothing here worth
  // surviving a reload - a customer who reloads mid-verify just requests a
  // fresh code.
  let myBookingsOtpSession = null;

  function showMyBookingsOtp(email) {
    myBookingsOtpEmailEl.textContent = email;
    myBookingsAuthForm.hidden = true;
    myBookingsOtp.hidden = false;
    myBookingsOtpStatus.classList.remove('success');
    myBookingsOtpStatus.textContent = '';
    myBookingsVerifyBtn.disabled = false;
    myBookingsResendBtn.disabled = false;
    clearMyBookingsOtpDigits(true);
  }

  function showMyBookingsAuthForm() {
    myBookingsOtpSession = null;
    myBookingsOtp.hidden = true;
    myBookingsAuthForm.hidden = false;
    myBookingsAuthStatus.classList.remove('success');
    myBookingsAuthStatus.textContent = '';
    clearMyBookingsOtpDigits(false);
  }

  myBookingsChangeEmailBtn.addEventListener('click', () => {
    showMyBookingsAuthForm();
    myBookingsEmailInput.focus();
  });

  // "Send 6-Digit Code" - POST /auth/start with just the email this gate
  // asks for (see the placeholder constants above for name/phone).
  myBookingsAuthForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = myBookingsEmailInput.value.trim();
    if (!email) return;

    myBookingsSendCodeBtn.disabled = true;
    myBookingsAuthStatus.classList.remove('success');
    myBookingsAuthStatus.textContent = 'Sending code...';

    try {
      const { session } = await callAuthStart(email, MY_BOOKINGS_PLACEHOLDER_NAME, MY_BOOKINGS_PLACEHOLDER_PHONE);
      myBookingsOtpSession = { email, session };
      myBookingsAuthStatus.textContent = '';
      showMyBookingsOtp(email);
    } catch (err) {
      myBookingsAuthStatus.textContent = err.message || 'Unable to send your verification code. Please try again.';
    } finally {
      myBookingsSendCodeBtn.disabled = false;
    }
  });

  // "Resend code" - calls /auth/start again and replaces the stored
  // challenge session with the new one; the old session is never reused.
  myBookingsResendBtn.addEventListener('click', async () => {
    if (!myBookingsOtpSession) return;
    const { email } = myBookingsOtpSession;

    myBookingsResendBtn.disabled = true;
    myBookingsOtpStatus.classList.remove('success');
    myBookingsOtpStatus.textContent = 'Sending a new code...';

    try {
      const { session } = await callAuthStart(email, MY_BOOKINGS_PLACEHOLDER_NAME, MY_BOOKINGS_PLACEHOLDER_PHONE);
      myBookingsOtpSession = { email, session };
      clearMyBookingsOtpDigits(true);
      myBookingsVerifyBtn.disabled = false;
      myBookingsOtpStatus.textContent = 'A new code is on its way to your email.';
    } catch (err) {
      myBookingsOtpStatus.textContent = err.message || 'Unable to send a new code. Please try again.';
    } finally {
      myBookingsResendBtn.disabled = false;
    }
  });

  // "Verify Code" - POST /auth/verify, then install the session with the
  // project's one existing Cognito session mechanism (CognitoAuth.
  // installPasswordlessSession() - the same call Reserve My Race's OTP step
  // makes) so getSession()/getAccessToken() everywhere else in the app
  // already see this visitor as signed in. No booking to create afterward - success
  // goes straight to refreshMyBookings() (js/my-bookings.js), which is also
  // the single source of truth for whether this gate stays visible.
  myBookingsVerifyBtn.addEventListener('click', async () => {
    if (!myBookingsOtpSession) {
      showMyBookingsAuthForm();
      myBookingsAuthStatus.textContent = 'Your verification session expired - please send a new code.';
      return;
    }

    const code = getMyBookingsOtpCode();
    if (!/^\d{6}$/.test(code)) {
      myBookingsOtpStatus.classList.remove('success');
      myBookingsOtpStatus.textContent = 'Enter all 6 digits of the code.';
      return;
    }

    const { email, session } = myBookingsOtpSession;
    myBookingsVerifyBtn.disabled = true;
    myBookingsResendBtn.disabled = true;
    myBookingsOtpStatus.classList.remove('success');
    myBookingsOtpStatus.textContent = 'Verifying...';

    try {
      const authResult = await callAuthVerify(email, code, session);
      // The one shared helper both OTP flows use (see js/cognito-auth.js) -
      // installs the tokens into the project's existing Cognito session
      // storage so getSession()/getAccessToken() (starting with
      // refreshMyBookings() right below) already recognize this visitor.
      // Handled in its own try/catch, separate from the outer one below:
      // /auth/verify has already succeeded and consumed the challenge at
      // this point, so a failure installing the session locally is a
      // different problem than a wrong/expired code and needs its own
      // message rather than being folded into that logic.
      try {
        await CognitoAuth.installPasswordlessSession(email, authResult);
      } catch (installErr) {
        console.warn(
          'Passwordless session install failed:',
          installErr instanceof Error ? installErr.message : 'unknown_error'
        );
        myBookingsOtpSession = null;
        myBookingsOtpStatus.classList.remove('success');
        myBookingsOtpStatus.textContent = 'We verified your code, but could not sign you in. Please request a new code and try again.';
        myBookingsVerifyBtn.disabled = false;
        myBookingsResendBtn.disabled = false;
        return;
      }
      myBookingsOtpSession = null;
      myBookingsOtpStatus.classList.add('success');
      myBookingsOtpStatus.textContent = 'Email verified.';
      clearMyBookingsOtpDigits(false);
      // Reset back to the default (email form) state for next time this
      // gate is shown, e.g. after Log Out - refreshMyBookings() below is
      // what actually decides whether it's visible right now, not this.
      myBookingsOtp.hidden = true;
      myBookingsAuthForm.hidden = false;
      myBookingsEmailInput.value = '';
      if (typeof refreshMyBookings === 'function') refreshMyBookings();
    } catch (err) {
      myBookingsOtpStatus.classList.remove('success');
      myBookingsVerifyBtn.disabled = false;
      myBookingsResendBtn.disabled = false;

      if (err.code === 'expired_session') {
        myBookingsOtpSession = null;
        myBookingsOtpStatus.textContent = `${err.message} Send a new code to continue.`;
      } else if (err.code === 'invalid_code') {
        // Cognito rotates the challenge session on every wrong attempt -
        // replace the stored one so a retry uses the current session, never
        // the stale one that was just rejected.
        if (err.session) myBookingsOtpSession = { email, session: err.session };
        myBookingsOtpStatus.textContent = err.message || 'The code you entered is incorrect.';
        clearMyBookingsOtpDigits(true);
      } else {
        myBookingsOtpStatus.textContent = err.message || 'Unable to verify your code. Please try again.';
      }
    }
  });
}

// Called last, after every element/const above it (including dateInput) is
// guaranteed to exist - see initBookingFormGuestUX()'s definition earlier in
// this file for what it does.
initBookingFormGuestUX();
