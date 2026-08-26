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

function formatBookingPrice(amount) {
  return '₹' + Number(amount).toLocaleString('en-IN');
}

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
}

// Booking form - front-end only (no backend wired up yet)
const bookingForm = document.getElementById('bookingForm');
const formStatus = document.getElementById('formStatus');

bookingForm.addEventListener('submit', (e) => {
  e.preventDefault();

  const data = Object.fromEntries(new FormData(bookingForm).entries());

  // TODO: replace with a real backend/booking API call (e.g. POST to your server,
  // a form service like Formspree, or an embedded booking platform).
  console.log('Booking request (not yet sent anywhere):', data);

  formStatus.textContent = `Thanks, ${data.name}! We've received your request for ${data.date} at ${data.time}. Our team will confirm your slot shortly.`;
  formStatus.classList.add('success');
  bookingForm.reset();
});

// bookingForm.reset() above fires a native 'reset' event - use it to put the
// Xperience-dependent Simulator field and summary back to their starting
// state too, since resetting the form doesn't do that on its own.
if (xperienceSelect && simulatorSelect) {
  bookingForm.addEventListener('reset', () => {
    setSimulatorPlaceholder('Select your Xperience first');
    bookingSummary.hidden = true;
  });
}

// Set minimum bookable date to today, and reject Mondays - Play X is closed
// that day, so a date picker with no restriction would let a customer
// request a slot that can never be honored.
const dateInput = document.getElementById('date');
if (dateInput) {
  const today = new Date().toISOString().split('T')[0];
  dateInput.setAttribute('min', today);

  dateInput.addEventListener('input', () => {
    if (!dateInput.value) {
      dateInput.setCustomValidity('');
      return;
    }
    const [y, m, d] = dateInput.value.split('-').map(Number);
    const isMonday = new Date(y, m - 1, d).getDay() === 1;
    dateInput.setCustomValidity(isMonday ? 'Play X Cafe is closed on Mondays - please choose another date.' : '');
  });
}
