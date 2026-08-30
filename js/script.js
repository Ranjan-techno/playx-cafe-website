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
// Requires a logged-in Play X account: the Cognito JWT authorizer on that
// route (infra/lib/constructs/api.ts) rejects an unauthenticated request
// outright, so the form itself is hidden behind bookingLoginGate until
// CognitoAuth confirms a session exists. Only productCode/bookingDate
// (date)/startTime (time)/notes are ever sent - Name/Phone/Email above are
// collected for the venue's own contact purposes but aren't part of that
// route's request body, and price is never sent: the backend always looks
// the current price up itself from the products table.
const bookingForm = document.getElementById('bookingForm');
const formStatus = document.getElementById('formStatus');
const bookingLoginGate = document.getElementById('bookingLoginGate');
const bookingResult = document.getElementById('bookingResult');

function resolveProductCode(selection, simulatorValue) {
  const { group, option } = selection;
  if (group.kind === 'signature') return option.productCode;
  return simulatorValue === 'motion' ? option.motionProductCode : option.staticProductCode;
}

async function refreshBookingGate() {
  if (!bookingLoginGate || !bookingForm) return;
  if (typeof CognitoAuth === 'undefined' || !CognitoAuth.isConfigured) {
    // Not deployed/configured yet - show the form itself rather than a login
    // gate, so the submit handler's "isn't set up yet" message (below) is
    // what the visitor sees, same degrade-gracefully pattern as the rest of
    // the site.
    bookingLoginGate.hidden = true;
    bookingForm.hidden = false;
    return;
  }
  const loggedIn = await CognitoAuth.isLoggedIn();
  bookingLoginGate.hidden = loggedIn;
  bookingForm.hidden = !loggedIn;
}
refreshBookingGate();

bookingForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  if (typeof CognitoAuth === 'undefined' || !CognitoAuth.isConfigured) {
    formStatus.classList.remove('success');
    formStatus.textContent = 'Booking isn\'t set up yet - add your AWS backend details in js/aws-config.js.';
    return;
  }

  const token = await CognitoAuth.getAccessToken();
  if (!token) {
    // Session expired between page load and submit (refreshBookingGate should
    // normally have already hidden the form in this case) - send the visitor
    // to log in and bring them straight back here afterwards.
    sessionStorage.setItem('pxPostLoginRedirect', 'index.html#booking');
    location.href = 'auth.html?mode=login';
    return;
  }

  const selection = getSelectedGroupOption(xperienceSelect.value);
  const productCode = selection ? resolveProductCode(selection, simulatorSelect.value) : null;
  if (!productCode) {
    formStatus.classList.remove('success');
    formStatus.textContent = 'Please select your Xperience (and Simulator, if applicable) first.';
    return;
  }

  const data = Object.fromEntries(new FormData(bookingForm).entries());
  const submitBtn = bookingForm.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  formStatus.classList.remove('success');
  formStatus.textContent = 'Sending your booking request...';
  bookingResult.hidden = true;

  try {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        productCode,
        bookingDate: data.date,
        startTime: data.time,
        notes: data.notes || null
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || 'Failed to create booking');

    formStatus.textContent = '';
    document.getElementById('resultXperience').textContent = getProductLabel(result.product);
    document.getElementById('resultDate').textContent = formatDateDisplay(result.date);
    document.getElementById('resultTime').textContent = formatTimeDisplay(result.time);
    document.getElementById('resultDuration').textContent = `${data.durationMinutes} min`;
    document.getElementById('resultPrice').textContent = formatBookingPrice(result.price);
    const resultStatusEl = document.getElementById('resultStatus');
    resultStatusEl.textContent = formatBookingStatus(result.status);
    resultStatusEl.className = `booking-status-pill ${result.status}`;
    bookingResult.hidden = false;
    bookingForm.reset();
    // Reflect the new booking in the My Bookings list (js/my-bookings.js)
    // right away instead of waiting for the visitor to reload the page.
    if (typeof refreshMyBookings === 'function') refreshMyBookings();
  } catch (err) {
    console.error('POST /bookings failed', err);
    formStatus.textContent = err.message || 'Something went wrong - please try again.';
  } finally {
    submitBtn.disabled = false;
  }
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
