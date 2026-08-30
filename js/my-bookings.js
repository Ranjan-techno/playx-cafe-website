// My Bookings section (#my-bookings) - GET /bookings/me for the signed-in
// customer. Requires js/aws-config.js + js/cognito-auth.js (auth),
// js/format-utils.js (date/time/price/status display formatting), and
// js/product-lookup.js (productCode -> experience/simulator) to be loaded
// first.

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
    </div>
  `;
}

async function refreshMyBookings() {
  const gate = document.getElementById('myBookingsLoggedOut');
  const statusEl = document.getElementById('myBookingsStatus');
  const listEl = document.getElementById('myBookingsList');
  if (!gate || !statusEl || !listEl) return;

  if (!CognitoAuth.isConfigured) {
    gate.hidden = true;
    listEl.hidden = true;
    statusEl.textContent = 'Booking history isn\'t set up yet - add your AWS backend details in js/aws-config.js.';
    return;
  }

  const token = await CognitoAuth.getAccessToken();
  if (!token) {
    gate.hidden = false;
    listEl.hidden = true;
    statusEl.textContent = '';
    return;
  }

  gate.hidden = true;
  listEl.hidden = true;
  statusEl.textContent = 'Loading your bookings...';

  try {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/bookings/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    const data = await response.json();

    if (!data.bookings || data.bookings.length === 0) {
      statusEl.textContent = 'No bookings yet - book your first session above.';
      return;
    }

    statusEl.textContent = '';
    listEl.innerHTML = data.bookings.map(renderBookingItem).join('');
    listEl.hidden = false;
  } catch (err) {
    console.error('GET /bookings/me failed', err);
    statusEl.textContent = 'Couldn\'t load your bookings right now - please try again later.';
  }
}

// No DOMContentLoaded wrapper needed - like every other script here, this
// file is loaded at the bottom of index.html, after the elements it
// references already exist.
refreshMyBookings();
