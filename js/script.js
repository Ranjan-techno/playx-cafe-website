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

// ----------------------------------------------------------------------
// Preferred Time: a fixed grid of 15-minute slots within Play X's opening
// hours (Tuesday-Sunday, 11:00 AM-11:00 PM - see
// backend/src/lib/opening-hours.ts, the source of truth this mirrors),
// narrowed to the latest slot that still lets the selected Xperience's
// session finish before closing (e.g. a 30-min session's last slot is
// 10:30 PM, not 10:45 PM). Labeled "Preferred Time" rather than a
// guaranteed slot on the form itself - there's no real-time availability
// check yet, so this only rules out start times the backend would reject
// outright.
// ----------------------------------------------------------------------
const OPENING_MINUTES = 11 * 60; // 11:00 AM
const CLOSING_MINUTES = 23 * 60; // 11:00 PM
const TIME_SLOT_MINUTES = 15;

function buildTimeSlots(durationMinutes) {
  const slots = [];
  const latestStart = CLOSING_MINUTES - durationMinutes;
  for (let minutes = OPENING_MINUTES; minutes <= latestStart; minutes += TIME_SLOT_MINUTES) {
    const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
    const mm = String(minutes % 60).padStart(2, '0');
    const value = `${hh}:${mm}`;
    slots.push({ value, label: formatTimeDisplay(value) });
  }
  return slots;
}

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

function populateTimeOptions(durationMinutes) {
  if (!timeSelect) return;
  const previousValue = timeSelect.value;
  timeSelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = 'Select a preferred time';
  timeSelect.appendChild(placeholder);
  buildTimeSlots(durationMinutes).forEach(({ value, label }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    timeSelect.appendChild(opt);
  });
  timeSelect.disabled = false;
  timeSelect.required = true;
  // Keep the customer's already-picked time if it's still a valid slot for
  // the (possibly new) duration, instead of silently clearing their choice.
  if (previousValue && Array.from(timeSelect.options).some((opt) => opt.value === previousValue)) {
    timeSelect.value = previousValue;
  }
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
    populateTimeOptions(option.durationMinutes);

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

// Namespaced so it's unambiguous in DevTools/sessionStorage what this key
// holds. Only ever holds the 7 plain fields built below - never a password,
// Cognito token, AWS credential, or any other secret.
const PENDING_BOOKING_STORAGE_KEY = 'playx_pending_booking';

function resolveProductCode(selection, simulatorValue) {
  const { group, option } = selection;
  if (group.kind === 'signature') return option.productCode;
  return simulatorValue === 'motion' ? option.motionProductCode : option.staticProductCode;
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
// used both by an already-signed-in visitor's ordinary submit and by
// attemptDraftAutoCompletion() below, so the fetch/render logic only exists
// once. Never touches sessionStorage itself: each caller decides what
// "success" means for its own draft bookkeeping. Returns { ok: true, result }
// or { ok: false } rather than throwing, so neither caller needs its own
// try/catch.
async function submitBookingRequest({ token, productCode, bookingDate, startTime, notes, durationMinutes, submitBtn }) {
  if (submitBtn) submitBtn.disabled = true;
  formStatus.classList.remove('success');
  formStatus.textContent = 'Sending your booking request...';
  bookingResult.hidden = true;

  try {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ productCode, bookingDate, startTime, notes: notes || null })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Failed to create booking');

    formStatus.textContent = '';
    document.getElementById('resultXperience').textContent = getProductLabel(result.product);
    document.getElementById('resultDate').textContent = formatDateDisplay(result.date);
    document.getElementById('resultTime').textContent = formatTimeDisplay(result.time);
    document.getElementById('resultDuration').textContent = `${durationMinutes} min`;
    document.getElementById('resultPrice').textContent = formatBookingPrice(result.price);
    const resultStatusEl = document.getElementById('resultStatus');
    resultStatusEl.textContent = formatBookingStatus(result.status);
    resultStatusEl.className = `booking-status-pill ${result.status}`;
    bookingResult.hidden = false;
    bookingForm.reset();
    // Reflect the new booking in the My Bookings list (js/my-bookings.js)
    // right away instead of waiting for the visitor to reload the page.
    if (typeof refreshMyBookings === 'function') refreshMyBookings();
    return { ok: true, result };
  } catch (err) {
    console.error('POST /bookings failed', err);
    formStatus.textContent = err.message || 'Something went wrong - please try again.';
    return { ok: false };
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

// Completes a booking that was started as a guest, now that a session
// exists - no extra click needed. getProductDetails() (js/product-lookup.js)
// supplies the duration for the result card since there's no live form fill
// to read it from (the draft was saved on an earlier visit). The draft is
// only cleared on success; a failure leaves it in place so it can be
// retried, e.g. by reloading the page.
async function attemptDraftAutoCompletion(token, draft) {
  const details = typeof getProductDetails === 'function' ? getProductDetails(draft.productCode) : null;
  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  const outcome = await submitBookingRequest({
    token,
    productCode: draft.productCode,
    bookingDate: draft.bookingDate,
    startTime: draft.startTime,
    notes: draft.notes,
    durationMinutes: details ? details.durationMinutes : null,
    submitBtn
  });
  if (outcome.ok) clearPendingBookingDraft();
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

bookingForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (typeof CognitoAuth === 'undefined' || !CognitoAuth.isConfigured) {
    formStatus.classList.remove('success');
    formStatus.textContent = 'Booking isn\'t set up yet - add your AWS backend details in js/aws-config.js.';
    return;
  }

  // Validate first: only ever build a draft (or POST) once the form's
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

  const token = await CognitoAuth.getAccessToken();
  if (!token) {
    // Guest (or an expired session) - save a normalized draft of exactly
    // what's needed to complete this booking once signed in, then send the
    // visitor to log in/sign up. Never POSTs on their behalf while
    // unauthenticated - attemptDraftAutoCompletion() does that automatically
    // on their next visit, once a session exists.
    try {
      const draft = {
        productCode,
        bookingDate: document.getElementById('date').value, // native YYYY-MM-DD, no conversion needed
        startTime: timeSelect.value, // already HH:mm - see buildTimeSlots()
        notes: notesInput.value || null,
        name: nameInput.value,
        phone: phoneInput.value,
        email: emailInput.value
      };
      sessionStorage.setItem(PENDING_BOOKING_STORAGE_KEY, JSON.stringify(draft));
    } catch (err) {
      // sessionStorage can throw in rare private-browsing edge cases - never
      // let that block the redirect below, just skip the auto-completion.
    }
    sessionStorage.setItem('pxPostLoginRedirect', 'index.html#booking');
    location.href = 'auth.html?mode=login';
    return;
  }

  // Already signed in - straight to booking creation, no draft detour.
  const data = Object.fromEntries(new FormData(bookingForm).entries());
  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  const outcome = await submitBookingRequest({
    token,
    productCode,
    bookingDate: data.date,
    startTime: data.time,
    notes: data.notes || null,
    durationMinutes: data.durationMinutes,
    submitBtn
  });
  // Defensive cleanup only - this branch never reads a draft, but a stale
  // one could exist from an earlier abandoned guest attempt in this tab.
  if (outcome.ok) clearPendingBookingDraft();
});

// bookingForm.reset() above fires a native 'reset' event - use it to put the
// Xperience-dependent Simulator field and summary back to their starting
// state too, since resetting the form doesn't do that on its own.
if (xperienceSelect && simulatorSelect) {
  bookingForm.addEventListener('reset', () => {
    setSimulatorPlaceholder('Select your Xperience first');
    setTimePlaceholder('Select your Xperience first');
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
  dateInput.setAttribute('min', todayIso);

  dateInput.addEventListener('input', () => {
    if (!dateInput.value) {
      dateInput.setCustomValidity('');
      if (dateError) dateError.hidden = true;
      return;
    }
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const isMonday = new Date(y, m - 1, d).getDay() === 1;
    const isPast = dateInput.value < todayIso;
    const message = isMonday ? MONDAY_MESSAGE : isPast ? PAST_DATE_MESSAGE : '';
    dateInput.setCustomValidity(message);
    if (dateError) {
      dateError.textContent = message;
      dateError.hidden = !message;
    }
  });
}

// Called last, after every element/const above it (including dateInput) is
// guaranteed to exist - see initBookingFormGuestUX()'s definition earlier in
// this file for what it does.
initBookingFormGuestUX();
