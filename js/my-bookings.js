// My Bookings section (#my-bookings) - GET /bookings/me for the signed-in
// customer, split client-side into an Upcoming / History toggle. Requires
// js/aws-config.js + js/cognito-auth.js (auth), js/format-utils.js
// (date/time/price/status display formatting), and js/product-lookup.js
// (productCode -> experience/simulator) to be loaded first.

// Escapes a booking's own free-text `notes` (typed by the customer at
// booking time - see js/script.js's booking form) before it's dropped into
// this template string via innerHTML, so a note containing "<"/"&" can't
// break the markup or inject anything.
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}

function renderBookingItem(booking) {
  const { experienceName, simulatorType } = getProductDetails(booking.product);
  return `
    <div class="booking-summary">
      <p class="booking-summary-title">Booking</p>
      <p class="booking-summary-value">${experienceName}</p>
      <div class="booking-summary-grid">
        <div class="summary-item">
          <span>Simulator</span>
          <strong>${simulatorType}</strong>
        </div>
        <div class="summary-item">
          <span>Date</span>
          <strong>${formatDateDisplay(booking.date)}</strong>
        </div>
        <div class="summary-item">
          <span>Time</span>
          <strong>${formatTimeDisplay(booking.time)}</strong>
        </div>
      </div>
      <div class="booking-summary-total">
        <span>Price</span>
        <strong>${formatBookingPrice(booking.price)}</strong>
      </div>
      <div class="booking-summary-status">
        <span>Status</span>
        <strong><span class="booking-status-pill ${booking.status}">${formatBookingStatus(booking.status)}</span></strong>
      </div>
      ${booking.notes ? `<p class="booking-notes"><span>Notes</span> ${escapeHtml(booking.notes)}</p>` : ''}
      <p class="booking-reference">Booking reference: ${escapeHtml(booking.id)}</p>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Upcoming/History split - Chennai/IST-safe.
//
// booking.date ("YYYY-MM-DD") and booking.time ("HH:MM", 24-hour) are the
// scheduled race's own wall-clock values, already in IST (Play X only ever
// operates in Chennai - see backend/database seed data). Concatenating them
// into one "YYYY-MM-DDTHH:MM" string and comparing those strings
// lexicographically sorts exactly like sorting the real date/times would,
// with none of the classic browser-timezone bugs a `new Date("YYYY-MM-DD
// HH:MM")` (parsed in whatever timezone the visitor's own device happens to
// be in) would introduce. "Now" is produced the same shape, but explicitly
// read out in Asia/Kolkata via Intl.DateTimeFormat regardless of the
// visitor's own device timezone, so a customer browsing from outside India
// still sees "upcoming" and "history" split the way Play X's front desk
// would see it.
// ---------------------------------------------------------------------
function bookingSortKey(booking) {
  return `${booking.date}T${booking.time}`;
}

function currentIstSortKey() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(new Date());
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

// Upcoming: scheduled date/time >= now (IST), soonest first.
// History: scheduled date/time < now (IST), most recent first.
// Deliberately sorts by the booking's own scheduled date/time, never by
// booking.createdAt (when the reservation was made, not when the race is).
function splitUpcomingAndHistory(bookings) {
  const nowKey = currentIstSortKey();
  const upcoming = [];
  const history = [];
  bookings.forEach((booking) => {
    (bookingSortKey(booking) >= nowKey ? upcoming : history).push(booking);
  });
  upcoming.sort((a, b) => (bookingSortKey(a) < bookingSortKey(b) ? -1 : 1));
  history.sort((a, b) => (bookingSortKey(a) < bookingSortKey(b) ? 1 : -1));
  return { upcoming, history };
}

let myBookingsUpcoming = [];
let myBookingsHistory = [];
let myBookingsActiveView = 'upcoming';

const myBookingsTabUpcomingBtn = document.getElementById('myBookingsTabUpcoming');
const myBookingsTabHistoryBtn = document.getElementById('myBookingsTabHistory');

function renderMyBookingsView() {
  const statusEl = document.getElementById('myBookingsStatus');
  const listEl = document.getElementById('myBookingsList');
  if (!statusEl || !listEl) return;

  if (myBookingsTabUpcomingBtn) myBookingsTabUpcomingBtn.classList.toggle('active', myBookingsActiveView === 'upcoming');
  if (myBookingsTabHistoryBtn) myBookingsTabHistoryBtn.classList.toggle('active', myBookingsActiveView === 'history');

  const bookings = myBookingsActiveView === 'upcoming' ? myBookingsUpcoming : myBookingsHistory;
  if (bookings.length === 0) {
    statusEl.textContent = myBookingsActiveView === 'upcoming' ? 'No upcoming races yet.' : 'No previous races yet.';
    listEl.hidden = true;
    listEl.innerHTML = '';
    return;
  }

  statusEl.textContent = '';
  listEl.innerHTML = bookings.map(renderBookingItem).join('');
  listEl.hidden = false;
}

if (myBookingsTabUpcomingBtn && myBookingsTabHistoryBtn) {
  myBookingsTabUpcomingBtn.addEventListener('click', () => {
    myBookingsActiveView = 'upcoming';
    renderMyBookingsView();
  });
  myBookingsTabHistoryBtn.addEventListener('click', () => {
    myBookingsActiveView = 'history';
    renderMyBookingsView();
  });
}

async function refreshMyBookings() {
  const gate = document.getElementById('myBookingsLoggedOut');
  const tabsEl = document.getElementById('myBookingsTabs');
  const statusEl = document.getElementById('myBookingsStatus');
  const listEl = document.getElementById('myBookingsList');
  if (!gate || !statusEl || !listEl) return;

  if (!CognitoAuth.isConfigured) {
    gate.hidden = true;
    if (tabsEl) tabsEl.hidden = true;
    listEl.hidden = true;
    statusEl.textContent = 'Booking history isn\'t set up yet - add your AWS backend details in js/aws-config.js.';
    return;
  }

  const token = await CognitoAuth.getAccessToken();
  if (!token) {
    gate.hidden = false;
    if (tabsEl) tabsEl.hidden = true;
    listEl.hidden = true;
    statusEl.textContent = '';
    return;
  }

  gate.hidden = true;
  if (tabsEl) tabsEl.hidden = true;
  listEl.hidden = true;
  statusEl.textContent = 'Loading your bookings...';

  try {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/bookings/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data = await response.json();

    const { upcoming, history } = splitUpcomingAndHistory(data.bookings || []);
    myBookingsUpcoming = upcoming;
    myBookingsHistory = history;
    myBookingsActiveView = 'upcoming';
    if (tabsEl) tabsEl.hidden = false;
    renderMyBookingsView();
  } catch (err) {
    console.error('GET /bookings/me failed', err);
    if (tabsEl) tabsEl.hidden = true;
    listEl.hidden = true;
    statusEl.textContent = 'Couldn\'t load your bookings right now - please try again later.';
  }
}

// No DOMContentLoaded wrapper needed - like every other script here, this
// file is loaded at the bottom of index.html, after the elements it
// references already exist.
refreshMyBookings();
