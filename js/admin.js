// Play X Admin (admin.html) - drives the whole page: passwordless OTP admin
// login, and the Dashboard/Bookings/Payments/Simulators views once a session
// is confirmed to belong to an actual Cognito "admin" group member.
//
// Reuses the exact same building blocks the customer-facing pages already
// use rather than inventing a second auth or fetch layer:
//   - js/aws-config.js for AWS_CONFIG/isAwsConfigured
//   - js/cognito-auth.js's CognitoAuth for the Cognito session itself
//     (getAccessToken/getSession/signOut/installPasswordlessSession) - the
//     SAME Cognito User Pool session storage index.html's My Bookings gate
//     uses, just requiring the signed-in user to also be in the "admin"
//     Cognito group, which only the backend ever checks (requireAdmin() in
//     backend/src/lib/admin-auth.ts) - this file never inspects the JWT
//     itself to decide who is an admin.
//   - js/format-utils.js for date/time/price/status display formatting.
//
// The OTP login sequence itself (POST /auth/start -> 6-digit code -> POST
// /auth/verify -> CognitoAuth.installPasswordlessSession()) is a deliberate
// copy of index.html/js/script.js's My Bookings sign-in gate - same backend
// endpoints, same request shapes, same error-code handling - kept as a
// separate copy (rather than a shared function) only because this project
// has no build step/module system to import across the two pages with.
//
// SECURITY: this file never decides who is an "admin". It only ever learns
// that from the backend's response to GET /admin/dashboard (200 = admin,
// 403 = authenticated but not an admin) and every other /admin/* call - a
// frontend-only gate would be exactly the kind of client-side authorization
// item 8 of this build's brief explicitly forbids.

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // DOM references
  // ------------------------------------------------------------------
  const loginScreen = document.getElementById('adminLoginScreen');
  const adminApp = document.getElementById('adminApp');

  const adminAuthForm = document.getElementById('adminAuthForm');
  const adminEmailInput = document.getElementById('adminEmail');
  const adminSendCodeBtn = document.getElementById('adminSendCodeBtn');
  const adminAuthStatus = document.getElementById('adminAuthStatus');

  const adminOtp = document.getElementById('adminOtp');
  const adminOtpEmailEl = document.getElementById('adminOtpEmail');
  const adminOtpDigitInputs = Array.from(document.querySelectorAll('.admin-otp-digit'));
  const adminVerifyBtn = document.getElementById('adminVerifyBtn');
  const adminResendBtn = document.getElementById('adminResendBtn');
  const adminChangeEmailBtn = document.getElementById('adminChangeEmailBtn');
  const adminOtpStatus = document.getElementById('adminOtpStatus');

  const adminForbidden = document.getElementById('adminForbidden');
  const adminForbiddenSignOutBtn = document.getElementById('adminForbiddenSignOutBtn');

  const adminAccountEmail = document.getElementById('adminAccountEmail');
  const adminSignOutBtn = document.getElementById('adminSignOutBtn');
  const adminTabs = document.getElementById('adminTabs');

  // POST /auth/start (backend/src/handlers/auth-start.ts) requires a
  // non-empty name and a valid Indian phone number on every call, but only
  // actually uses them the first time a given email signs in (to create the
  // Cognito user) - see that handler's header. An admin account is expected
  // to already exist and already be a member of the "admin" Cognito group
  // (this build never creates that membership - see this page's final
  // report), so these placeholders only matter in the unlikely case of a
  // brand-new admin email; same pattern as index.html's My Bookings gate.
  const ADMIN_PLACEHOLDER_NAME = 'Play X Admin';
  const ADMIN_PLACEHOLDER_PHONE = '0000000000';

  // ------------------------------------------------------------------
  // Small shared helpers
  // ------------------------------------------------------------------
  function escapeHtml(value) {
    const div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML;
  }

  function dash(value) {
    return value === null || value === undefined || value === '' ? '—' : value;
  }

  // Short, human-scannable form of a booking/payment UUID - the full value
  // is always kept in the title attribute so nothing is actually hidden.
  function shortId(id) {
    if (!id) return '—';
    return id.length > 10 ? `${id.slice(0, 8)}…` : id;
  }

  // The human-visible booking reference - the operational UI standard is "Booking #1007", never
  // a bare "#1007" - see backend/database/migrations/004_short_booking_number.sql and this repo's
  // CLAUDE.md. Every place this page used to show a (truncated) booking UUID to a human now shows
  // this instead; the UUID itself is untouched everywhere internal - data-booking-id attributes,
  // click handlers, and every /admin/* call still use it exclusively. Falls back to a "Booking
  // <shortId>" form only if bookingNumber is ever missing (e.g. a backend not yet redeployed with
  // this field) so a cell is never left blank. Returns the FULL string - callers must render it
  // as-is and must never prepend their own "Booking " text, or the result reads "Booking Booking
  // #1007".
  function bookingRef(bookingNumber, id) {
    if (typeof bookingNumber === 'number' && Number.isFinite(bookingNumber)) {
      return `Booking #${bookingNumber}`;
    }
    return `Booking ${shortId(id)}`;
  }

  // Normalizes whatever an operations executive pastes into the bookings search box down to the
  // bare 4-digit booking number GET /admin/bookings' exact-match search expects (see
  // backend/src/lib/admin-repository.ts's parseBookingNumberSearch()) - "1001", "#1001", and
  // "Booking #1001" (the exact text this page now displays everywhere - see bookingRef()) all
  // normalize to "1001". Anything else (a name, email, phone number) is returned unchanged, so the
  // existing ILIKE search behavior for those is never affected.
  function normalizeBookingSearch(raw) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^(?:booking\s*)?#?\s*(\d{4})$/i);
    return match ? match[1] : trimmed;
  }

  function formatDateTimeDisplay(isoString) {
    if (!isoString) return '—';
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return isoString;
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(d);
    const part = (type) => parts.find((p) => p.type === type).value;
    return `${part('day')} ${part('month')} ${part('year')}, ${part('hour')}:${part('minute')} IST`;
  }

  function todayIstDate() {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const part = (type) => parts.find((p) => p.type === type).value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  function setStatus(el, message, kind) {
    if (!el) return;
    el.textContent = message || '';
    el.classList.remove('error', 'success');
    if (kind) el.classList.add(kind);
  }

  // ------------------------------------------------------------------
  // adminFetch() - the one place every /admin/* call goes through.
  //
  // Attaches "Authorization: Bearer <access token>" exactly as
  // js/my-bookings.js already does for GET /bookings/me, and classifies the
  // outcome so every caller handles 401/403/network failures the same way
  // (item 8 of this build's brief) instead of re-deriving that logic per
  // view:
  //   - unauthenticated: no token at all, or the API said 401 -> the
  //     Cognito session is missing/expired; back to the login screen.
  //   - forbidden: the API said 403 -> a real, authenticated Cognito user
  //     who is genuinely not an "admin" (backend requireAdmin() said so).
  //     Never something this file decides on its own.
  //   - error: any other non-2xx status (400/404/409/500/...).
  //   - network: fetch() itself threw (offline, DNS, CORS, ...).
  //   - ok: 2xx, `data` is the parsed JSON body.
  // ------------------------------------------------------------------
  async function adminFetch(path, options) {
    options = options || {};
    if (!CognitoAuth.isConfigured) {
      return { kind: 'network', message: 'AWS backend isn\'t configured yet (js/aws-config.js).' };
    }

    const token = await CognitoAuth.getAccessToken();
    if (!token) {
      return { kind: 'unauthenticated' };
    }

    let response;
    try {
      const headers = Object.assign({ Authorization: `Bearer ${token}` }, options.headers || {});
      if (options.body !== undefined) headers['Content-Type'] = 'application/json';
      response = await fetch(`${AWS_CONFIG.apiBaseUrl}${path}`, {
        method: options.method || 'GET',
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined
      });
    } catch (err) {
      console.error(`Admin request failed: ${path}`, err);
      return { kind: 'network' };
    }

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) return { kind: 'unauthenticated' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (!response.ok) return { kind: 'error', status: response.status, data };
    return { kind: 'ok', data };
  }

  // Generic reaction to an adminFetch() result inside a specific view: shows
  // a message in that view's own status element for 'error'/'network', and
  // hands off session-level problems (unauthenticated/forbidden) to the
  // whole-page handlers below instead of leaving a stale admin screen up.
  function reportViewError(statusEl, result, fallbackMessage) {
    if (result.kind === 'unauthenticated') {
      exitToLogin('Your session has expired. Please sign in again.');
      return;
    }
    if (result.kind === 'forbidden') {
      exitToForbidden();
      return;
    }
    if (result.kind === 'error') {
      setStatus(statusEl, (result.data && result.data.message) || fallbackMessage, 'error');
      return;
    }
    setStatus(statusEl, 'Network error - please check your connection and try again.', 'error');
  }

  // ==================================================================
  // LOGIN - passwordless OTP (mirrors index.html's My Bookings gate)
  // ==================================================================

  // Holds the Cognito CUSTOM_AUTH challenge session between POST /auth/start
  // and POST /auth/verify. In memory only, same reasoning as
  // js/script.js's myBookingsOtpSession - nothing here is worth surviving a
  // reload.
  let otpSession = null;

  function getOtpCode() {
    return adminOtpDigitInputs.map((input) => input.value).join('');
  }

  function clearOtpDigits(focusFirst) {
    adminOtpDigitInputs.forEach((input) => { input.value = ''; });
    if (focusFirst && adminOtpDigitInputs[0]) adminOtpDigitInputs[0].focus();
  }

  adminOtpDigitInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);
      if (input.value && index < adminOtpDigitInputs.length - 1) {
        adminOtpDigitInputs[index + 1].focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value && index > 0) {
        e.preventDefault();
        adminOtpDigitInputs[index - 1].value = '';
        adminOtpDigitInputs[index - 1].focus();
      } else if (e.key === 'ArrowLeft' && index > 0) {
        adminOtpDigitInputs[index - 1].focus();
      } else if (e.key === 'ArrowRight' && index < adminOtpDigitInputs.length - 1) {
        adminOtpDigitInputs[index + 1].focus();
      }
    });
    input.addEventListener('paste', (e) => {
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      if (!pasted) return;
      e.preventDefault();
      pasted.slice(0, adminOtpDigitInputs.length).split('').forEach((digit, i) => {
        adminOtpDigitInputs[i].value = digit;
      });
      const lastFilledIndex = Math.min(pasted.length, adminOtpDigitInputs.length) - 1;
      adminOtpDigitInputs[Math.max(lastFilledIndex, 0)].focus();
    });
  });

  async function callAuthStart(email) {
    const response = await fetch(`${AWS_CONFIG.apiBaseUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name: ADMIN_PLACEHOLDER_NAME, phone: ADMIN_PLACEHOLDER_PHONE })
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
      err.session = body.session;
      throw err;
    }
    return body; // { idToken, accessToken, refreshToken, expiresIn }
  }

  function showLoginForm() {
    otpSession = null;
    adminForbidden.hidden = true;
    adminOtp.hidden = true;
    adminAuthForm.hidden = false;
    setStatus(adminAuthStatus, '');
    setStatus(adminOtpStatus, '');
    clearOtpDigits(false);
  }

  function showOtpStep(email) {
    adminOtpEmailEl.textContent = email;
    adminAuthForm.hidden = true;
    adminForbidden.hidden = true;
    adminOtp.hidden = false;
    setStatus(adminOtpStatus, '');
    adminVerifyBtn.disabled = false;
    adminResendBtn.disabled = false;
    clearOtpDigits(true);
  }

  // Reached only after a genuinely authenticated Cognito session came back
  // 403 from GET /admin/dashboard - a real backend authorization decision,
  // never one this file makes itself (see this file's header).
  function exitToForbidden() {
    adminApp.hidden = true;
    loginScreen.hidden = false;
    adminAuthForm.hidden = true;
    adminOtp.hidden = true;
    setStatus(adminAuthStatus, '');
    adminForbidden.hidden = false;
  }

  function exitToLogin(message) {
    adminApp.hidden = true;
    loginScreen.hidden = false;
    showLoginForm();
    if (message) setStatus(adminAuthStatus, message, 'error');
  }

  adminAuthForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = adminEmailInput.value.trim();
    if (!email) return;

    adminSendCodeBtn.disabled = true;
    setStatus(adminAuthStatus, 'Sending code...');

    try {
      const { session } = await callAuthStart(email);
      otpSession = { email, session };
      setStatus(adminAuthStatus, '');
      showOtpStep(email);
    } catch (err) {
      setStatus(adminAuthStatus, err.message || 'Unable to send your verification code. Please try again.', 'error');
    } finally {
      adminSendCodeBtn.disabled = false;
    }
  });

  adminResendBtn.addEventListener('click', async () => {
    if (!otpSession) return;
    const { email } = otpSession;
    adminResendBtn.disabled = true;
    setStatus(adminOtpStatus, 'Sending a new code...');
    try {
      const { session } = await callAuthStart(email);
      otpSession = { email, session };
      clearOtpDigits(true);
      adminVerifyBtn.disabled = false;
      setStatus(adminOtpStatus, 'A new code is on its way to your email.');
    } catch (err) {
      setStatus(adminOtpStatus, err.message || 'Unable to send a new code. Please try again.', 'error');
    } finally {
      adminResendBtn.disabled = false;
    }
  });

  adminChangeEmailBtn.addEventListener('click', () => {
    showLoginForm();
    adminEmailInput.focus();
  });

  adminVerifyBtn.addEventListener('click', async () => {
    if (!otpSession) {
      showLoginForm();
      setStatus(adminAuthStatus, 'Your verification session expired - please send a new code.', 'error');
      return;
    }

    const code = getOtpCode();
    if (!/^\d{6}$/.test(code)) {
      setStatus(adminOtpStatus, 'Enter all 6 digits of the code.', 'error');
      return;
    }

    const { email, session } = otpSession;
    adminVerifyBtn.disabled = true;
    adminResendBtn.disabled = true;
    setStatus(adminOtpStatus, 'Verifying...');

    try {
      const authResult = await callAuthVerify(email, code, session);
      try {
        await CognitoAuth.installPasswordlessSession(email, authResult);
      } catch (installErr) {
        console.warn('Passwordless session install failed:', installErr instanceof Error ? installErr.message : 'unknown_error');
        setStatus(adminOtpStatus, 'We verified your code, but could not sign you in. Please request a new code and try again.', 'error');
        adminVerifyBtn.disabled = false;
        adminResendBtn.disabled = false;
        return;
      }

      otpSession = null;
      setStatus(adminOtpStatus, 'Email verified. Checking admin access...', 'success');
      await enterAppIfAdmin(email);
    } catch (err) {
      adminVerifyBtn.disabled = false;
      adminResendBtn.disabled = false;
      if (err.code === 'expired_session') {
        otpSession = null;
        setStatus(adminOtpStatus, `${err.message} Send a new code to continue.`, 'error');
      } else if (err.code === 'invalid_code') {
        if (err.session) otpSession = { email, session: err.session };
        setStatus(adminOtpStatus, err.message || 'The code you entered is incorrect.', 'error');
        clearOtpDigits(true);
      } else {
        setStatus(adminOtpStatus, err.message || 'Unable to verify your code. Please try again.', 'error');
      }
    }
  });

  // The ONLY authorization check this page performs: ask the backend
  // (GET /admin/dashboard, itself protected by JWT auth + requireAdmin())
  // whether the now-signed-in Cognito user is allowed in. 200 -> render the
  // dashboard data this same call already returned; 403 -> the account is
  // real but not an admin; anything else -> a plain error, session left
  // intact so the admin can retry rather than being bounced to login again.
  async function enterAppIfAdmin(email) {
    const result = await adminFetch('/admin/dashboard');
    if (result.kind === 'ok') {
      adminAccountEmail.textContent = email;
      loginScreen.hidden = true;
      adminApp.hidden = false;
      renderDashboard(result.data);
      switchView('dashboard');
      return;
    }
    if (result.kind === 'forbidden') {
      exitToForbidden();
      return;
    }
    if (result.kind === 'unauthenticated') {
      exitToLogin('Your session has expired. Please sign in again.');
      return;
    }
    setStatus(adminOtpStatus, 'Signed in, but could not reach the admin backend. Please try again.', 'error');
    adminVerifyBtn.disabled = false;
    adminResendBtn.disabled = false;
  }

  adminForbiddenSignOutBtn.addEventListener('click', () => {
    CognitoAuth.signOut();
    exitToLogin();
  });

  adminSignOutBtn.addEventListener('click', () => {
    CognitoAuth.signOut();
    exitToLogin();
  });

  // On load: if a valid Cognito session already exists (e.g. a reload, or a
  // signed-in admin returning), skip straight to the admin check instead of
  // asking for a fresh OTP every time - same persistence
  // CognitoAuth/index.html already provide.
  async function resumeSessionOnLoad() {
    if (!CognitoAuth.isConfigured) {
      setStatus(adminAuthStatus, 'AWS backend isn\'t configured yet - see js/aws-config.js.', 'error');
      return;
    }
    setStatus(adminAuthStatus, 'Checking for an existing session...');
    const session = await CognitoAuth.getSession();
    if (!session) {
      setStatus(adminAuthStatus, '');
      return;
    }
    const claims = session.getIdToken().decodePayload();
    const email = (claims && claims.email) || '';
    await enterAppIfAdmin(email);
  }

  // ==================================================================
  // View routing (Dashboard / Bookings / Payments / Simulators)
  // ==================================================================
  const views = {
    dashboard: document.getElementById('view-dashboard'),
    bookings: document.getElementById('view-bookings'),
    payments: document.getElementById('view-payments'),
    simulators: document.getElementById('view-simulators')
  };
  const loadedViews = { dashboard: false, bookings: false, payments: false, simulators: false };

  function switchView(name) {
    Object.keys(views).forEach((key) => {
      views[key].classList.toggle('active', key === name);
    });
    Array.from(adminTabs.querySelectorAll('.admin-tab')).forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === name);
    });
    if (!loadedViews[name]) {
      loadedViews[name] = true;
      if (name === 'bookings') loadBookings(true);
      if (name === 'payments') loadPayments(true);
      if (name === 'simulators') loadSimulators();
    }
  }

  adminTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.admin-tab');
    if (btn) switchView(btn.dataset.view);
  });

  // ==================================================================
  // DASHBOARD - GET /admin/dashboard
  // ==================================================================
  const dashboardStatus = document.getElementById('dashboardStatus');
  const dashboardCards = document.getElementById('dashboardCards');
  const dashboardDate = document.getElementById('dashboardDate');
  const dashboardRefreshBtn = document.getElementById('dashboardRefreshBtn');

  function dashboardCard(label, value, breakdownHtml, accent) {
    return `
      <div class="admin-card">
        <div class="admin-card-label">${escapeHtml(label)}</div>
        <div class="admin-card-value${accent ? ' accent' : ''}">${escapeHtml(value)}</div>
        ${breakdownHtml ? `<div class="admin-card-breakdown">${breakdownHtml}</div>` : ''}
      </div>
    `;
  }

  function breakdownItem(label, value) {
    return `<span>${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></span>`;
  }

  // Only ever renders fields DashboardSummary actually returns
  // (backend/src/lib/admin-repository.ts) - nothing here is invented.
  function renderDashboard(summary) {
    dashboardDate.textContent = summary.date ? `Business day: ${formatDateDisplay(summary.date)} (IST)` : '';

    const cards = [
      dashboardCard(
        'Bookings Today',
        summary.bookings.total,
        breakdownItem('Confirmed', summary.bookings.confirmed) + breakdownItem('Pending', summary.bookings.pending) + breakdownItem('Cancelled', summary.bookings.cancelled)
      ),
      dashboardCard('Pending Bookings', summary.bookings.pending, '', true),
      dashboardCard('Confirmed Bookings', summary.bookings.confirmed),
      dashboardCard(
        'Active Holds',
        summary.holds.active,
        breakdownItem('Expired', summary.holds.expired)
      ),
      dashboardCard(
        'Payments Paid',
        summary.payments.paid,
        breakdownItem('Pending', summary.payments.pending) + breakdownItem('Failed', summary.payments.failed)
      ),
      dashboardCard('Revenue (Paid)', formatBookingPrice(summary.revenue.paidInr), '', true),
      dashboardCard(
        'Simulators',
        summary.simulators.total,
        breakdownItem('Static', summary.simulators.static) + breakdownItem('Motion', summary.simulators.motion)
      )
    ];

    dashboardCards.innerHTML = cards.join('');
    dashboardCards.hidden = false;
    setStatus(dashboardStatus, '');
  }

  async function loadDashboard() {
    setStatus(dashboardStatus, 'Loading dashboard...');
    dashboardCards.hidden = true;
    const result = await adminFetch('/admin/dashboard');
    if (result.kind === 'ok') {
      renderDashboard(result.data);
    } else {
      reportViewError(dashboardStatus, result, 'Could not load the dashboard right now.');
    }
  }

  dashboardRefreshBtn.addEventListener('click', loadDashboard);

  // ==================================================================
  // BOOKINGS - GET /admin/bookings, GET /admin/bookings/{id},
  //            PATCH /admin/bookings/{id}/status
  // ==================================================================
  const bookingsStatus = document.getElementById('bookingsStatus');
  const bookingsTableWrap = document.getElementById('bookingsTableWrap');
  const bookingsTableBody = document.getElementById('bookingsTableBody');
  const bookingsLoadMoreBtn = document.getElementById('bookingsLoadMoreBtn');
  const bookingsFilters = document.getElementById('bookingsFilters');
  const bookingsFilterDate = document.getElementById('bookingsFilterDate');
  const bookingsFilterStatus = document.getElementById('bookingsFilterStatus');
  const bookingsFilterSearch = document.getElementById('bookingsFilterSearch');
  const bookingsFilterClearBtn = document.getElementById('bookingsFilterClearBtn');

  let bookingsItems = [];
  let bookingsCursor = null;
  let bookingsFilterState = {};

  function paymentPill(payment) {
    if (!payment) return '<span class="admin-cell-muted">No payment</span>';
    return `<span class="admin-payment-pill ${escapeHtml(payment.status)}">${escapeHtml(payment.status)}</span> <span class="admin-cell-sub">${escapeHtml(payment.provider)}</span>`;
  }

  function bookingRow(item) {
    const customerLines = [item.customerName, item.customerEmail, item.customerPhone].filter(Boolean);
    return `
      <tr class="admin-row-clickable" data-booking-id="${escapeHtml(item.id)}">
        <td data-label="Booking"><span title="${escapeHtml(item.id)}">${escapeHtml(bookingRef(item.bookingNumber, item.id))}</span><span class="admin-cell-sub">${escapeHtml(formatDateDisplay(item.date))}</span></td>
        <td data-label="Customer" class="admin-td-wrap">${customerLines.length ? escapeHtml(customerLines.join(' · ')) : '<span class="admin-cell-muted">—</span>'}</td>
        <td data-label="Product">${escapeHtml(item.product.name)}<span class="admin-cell-sub">${escapeHtml(item.product.code)}</span></td>
        <td data-label="Date">${escapeHtml(formatDateDisplay(item.date))}</td>
        <td data-label="Time">${escapeHtml(formatTimeDisplay(item.time))}</td>
        <td data-label="Price">${escapeHtml(formatBookingPrice(item.priceInr))}</td>
        <td data-label="Status"><span class="booking-status-pill ${escapeHtml(item.status)}">${escapeHtml(formatBookingStatus(item.status))}</span></td>
        <td data-label="Payment">${paymentPill(item.payment)}</td>
        <td data-label="Simulators">${item.allocatedSimulators.length ? escapeHtml(item.allocatedSimulators.join(', ')) : '<span class="admin-cell-muted">—</span>'}</td>
      </tr>
    `;
  }

  function renderBookingsTable() {
    bookingsTableBody.innerHTML = bookingsItems.map(bookingRow).join('');
    bookingsTableWrap.hidden = bookingsItems.length === 0;
    if (bookingsItems.length === 0) {
      setStatus(bookingsStatus, 'No bookings match these filters.');
    } else {
      setStatus(bookingsStatus, '');
    }
  }

  function buildQuery(params) {
    const usp = new URLSearchParams();
    Object.keys(params).forEach((key) => {
      const value = params[key];
      if (value !== undefined && value !== null && value !== '') usp.set(key, value);
    });
    const qs = usp.toString();
    return qs ? `?${qs}` : '';
  }

  async function loadBookings(reset) {
    if (reset) {
      bookingsItems = [];
      bookingsCursor = null;
      bookingsTableWrap.hidden = true;
    }
    setStatus(bookingsStatus, 'Loading bookings...');
    bookingsLoadMoreBtn.hidden = true;

    const query = buildQuery(Object.assign({}, bookingsFilterState, { limit: 20, cursor: bookingsCursor || undefined }));
    const result = await adminFetch(`/admin/bookings${query}`);
    if (result.kind !== 'ok') {
      reportViewError(bookingsStatus, result, 'Could not load bookings right now.');
      return;
    }

    bookingsItems = bookingsItems.concat(result.data.items || []);
    bookingsCursor = result.data.nextCursor || null;
    renderBookingsTable();
    bookingsLoadMoreBtn.hidden = !bookingsCursor;
  }

  bookingsFilters.addEventListener('submit', (e) => {
    e.preventDefault();
    // "1001", "#1001", or "Booking #1001" (exactly what this page displays - see bookingRef())
    // are all normalized to the bare number before being sent, so any of the three matches the
    // same exact booking_number search GET /admin/bookings does - see
    // backend/src/lib/admin-repository.ts's parseBookingNumberSearch().
    const search = normalizeBookingSearch(bookingsFilterSearch.value);
    bookingsFilterState = {
      date: bookingsFilterDate.value || undefined,
      status: bookingsFilterStatus.value || undefined,
      search: search || undefined
    };
    loadBookings(true);
  });

  bookingsFilterClearBtn.addEventListener('click', () => {
    bookingsFilterDate.value = '';
    bookingsFilterStatus.value = '';
    bookingsFilterSearch.value = '';
    bookingsFilterState = {};
    loadBookings(true);
  });

  bookingsLoadMoreBtn.addEventListener('click', () => loadBookings(false));

  bookingsTableBody.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-booking-id]');
    if (row) openBookingDetail(row.dataset.bookingId);
  });

  // ---- Booking detail overlay ----
  const bookingDetailOverlay = document.getElementById('bookingDetailOverlay');
  const bookingDetailBackdrop = document.getElementById('bookingDetailBackdrop');
  const bookingDetailCloseBtn = document.getElementById('bookingDetailCloseBtn');
  const bookingDetailStatus = document.getElementById('bookingDetailStatus');
  const bookingDetailBody = document.getElementById('bookingDetailBody');

  // Mirrors backend/src/lib/booking-status.ts's ALLOWED_TRANSITIONS - a pure
  // UX hint for which options to offer in the dropdown, never a security
  // boundary: the backend re-validates every transition itself and this
  // page never assumes its own copy is authoritative (item 8 of this
  // build's brief).
  const ALLOWED_TRANSITIONS = {
    pending: ['confirmed', 'cancelled'],
    confirmed: ['cancelled', 'completed', 'no_show'],
    cancelled: [],
    completed: [],
    no_show: []
  };
  const STATUS_LABELS = {
    pending: 'Pending',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
    completed: 'Completed',
    no_show: 'No Show'
  };

  let currentBookingId = null;

  function closeBookingDetail() {
    bookingDetailOverlay.hidden = true;
    currentBookingId = null;
  }
  bookingDetailBackdrop.addEventListener('click', closeBookingDetail);
  bookingDetailCloseBtn.addEventListener('click', closeBookingDetail);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !bookingDetailOverlay.hidden) closeBookingDetail();
  });

  function allocationRow(a) {
    return `
      <tr>
        <td>${escapeHtml(a.simulatorCode)}</td>
        <td>${escapeHtml(a.simulatorType)}</td>
        <td>${escapeHtml(a.status)}</td>
        <td>${escapeHtml(formatDateTimeDisplay(a.scheduledStartAt))}</td>
        <td>${a.holdExpiresAt ? escapeHtml(formatDateTimeDisplay(a.holdExpiresAt)) : '—'}</td>
      </tr>
    `;
  }

  function paymentAttemptRow(p) {
    return `
      <tr>
        <td title="${escapeHtml(p.id)}">${escapeHtml(shortId(p.id))}</td>
        <td>${escapeHtml(p.provider)}</td>
        <td>${escapeHtml(formatBookingPrice(p.amountInr))} ${escapeHtml(p.currency)}</td>
        <td><span class="admin-payment-pill ${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
        <td title="${escapeHtml(p.providerOrderId)} / ${escapeHtml(p.providerTransactionId || '')}">${escapeHtml(shortId(p.providerOrderId))}</td>
        <td>${escapeHtml(formatDateTimeDisplay(p.createdAt))}</td>
      </tr>
    `;
  }

  function renderStatusControl(detail) {
    const options = ALLOWED_TRANSITIONS[detail.status] || [];
    if (options.length === 0) {
      return '<p class="admin-cell-muted">This booking\'s status is final - no further transitions are available.</p>';
    }
    const optionHtml = options.map((s) => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join('');
    return `
      <div class="admin-status-change">
        <select id="bookingStatusSelect">${optionHtml}</select>
        <button type="button" class="btn btn-primary" id="bookingStatusUpdateBtn">Update Status</button>
      </div>
      <div id="bookingStatusConfirmBox"></div>
      <p class="admin-status" id="bookingStatusMessage" role="status" aria-live="polite"></p>
    `;
  }

  function renderBookingDetail(detail) {
    bookingDetailBody.innerHTML = `
      <div class="admin-detail-section">
        <h3>Customer</h3>
        <div class="admin-detail-grid">
          <div><span>Name</span><strong>${escapeHtml(dash(detail.customer.name))}</strong></div>
          <div><span>Email</span><strong>${escapeHtml(dash(detail.customer.email))}</strong></div>
          <div><span>Phone</span><strong>${escapeHtml(dash(detail.customer.phone))}</strong></div>
        </div>
      </div>

      <div class="admin-detail-section">
        <h3>Booking</h3>
        <div class="admin-detail-grid">
          <div><span>Reference</span><strong title="${escapeHtml(detail.id)}">${escapeHtml(bookingRef(detail.bookingNumber, detail.id))}</strong></div>
          <div><span>Product</span><strong>${escapeHtml(detail.product.name)}</strong></div>
          <div><span>Simulator Type</span><strong>${escapeHtml(dash(detail.product.simulatorType))}</strong></div>
          <div><span>Racers</span><strong>${escapeHtml(detail.product.racers)}</strong></div>
          <div><span>Duration</span><strong>${escapeHtml(detail.product.durationMinutes)} min</strong></div>
          <div><span>Date</span><strong>${escapeHtml(formatDateDisplay(detail.date))}</strong></div>
          <div><span>Time</span><strong>${escapeHtml(formatTimeDisplay(detail.time))}</strong></div>
          <div><span>Price</span><strong>${escapeHtml(formatBookingPrice(detail.priceInr))}</strong></div>
          <div><span>Status</span><strong><span class="booking-status-pill ${escapeHtml(detail.status)}">${escapeHtml(formatBookingStatus(detail.status))}</span></strong></div>
          <div><span>Payment</span><strong>${detail.currentPaymentStatus ? `<span class="admin-payment-pill ${escapeHtml(detail.currentPaymentStatus)}">${escapeHtml(detail.currentPaymentStatus)}</span>` : '—'}</strong></div>
          <div><span>Created</span><strong>${escapeHtml(formatDateTimeDisplay(detail.createdAt))}</strong></div>
          <div><span>Updated</span><strong>${escapeHtml(formatDateTimeDisplay(detail.updatedAt))}</strong></div>
        </div>
        ${detail.notes ? `<div class="admin-notes-box">${escapeHtml(detail.notes)}</div>` : ''}
      </div>

      <div class="admin-detail-section">
        <h3>Update Status</h3>
        ${renderStatusControl(detail)}
      </div>

      <div class="admin-detail-section">
        <h3>Simulator Allocations</h3>
        ${detail.allocations.length ? `
          <table class="admin-mini-table">
            <thead><tr><th>Simulator</th><th>Type</th><th>Status</th><th>Scheduled</th><th>Hold Expires</th></tr></thead>
            <tbody>${detail.allocations.map(allocationRow).join('')}</tbody>
          </table>
        ` : '<p class="admin-cell-muted">No allocations.</p>'}
      </div>

      <div class="admin-detail-section">
        <h3>Payment Attempts</h3>
        ${detail.payments.length ? `
          <table class="admin-mini-table">
            <thead><tr><th>ID</th><th>Provider</th><th>Amount</th><th>Status</th><th>Order ID</th><th>Created</th></tr></thead>
            <tbody>${detail.payments.map(paymentAttemptRow).join('')}</tbody>
          </table>
        ` : '<p class="admin-cell-muted">No payment attempts yet.</p>'}
      </div>
    `;

    const updateBtn = document.getElementById('bookingStatusUpdateBtn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        const select = document.getElementById('bookingStatusSelect');
        const targetStatus = select.value;
        if (targetStatus === 'cancelled') {
          showCancelConfirm(detail.id, targetStatus);
        } else {
          submitStatusChange(detail.id, targetStatus);
        }
      });
    }
  }

  function showCancelConfirm(bookingId, targetStatus) {
    const box = document.getElementById('bookingStatusConfirmBox');
    if (!box) return;
    box.innerHTML = `
      <div class="admin-confirm-box">
        <p>Cancel this booking? This releases its simulator allocation and cannot be undone.</p>
        <div class="admin-confirm-box-actions">
          <button type="button" class="btn btn-primary" id="confirmCancelYes">Yes, Cancel Booking</button>
          <button type="button" class="btn btn-outline" id="confirmCancelNo">No, Keep It</button>
        </div>
      </div>
    `;
    document.getElementById('confirmCancelYes').addEventListener('click', () => submitStatusChange(bookingId, targetStatus));
    document.getElementById('confirmCancelNo').addEventListener('click', () => { box.innerHTML = ''; });
  }

  async function submitStatusChange(bookingId, targetStatus) {
    const messageEl = document.getElementById('bookingStatusMessage');
    setStatus(messageEl, 'Updating status...');
    const result = await adminFetch(`/admin/bookings/${encodeURIComponent(bookingId)}/status`, {
      method: 'PATCH',
      body: { status: targetStatus }
    });

    if (result.kind === 'ok') {
      const updatedStatus = result.data.status;
      // Item 4's requirement: refresh both this booking and the dashboard.
      // Re-fetches and repaints the whole detail body first (a fresh
      // #bookingStatusMessage comes with it), then puts the confirmation on
      // that new element - setting it before the repaint would just be
      // wiped out by openBookingDetail()'s own "Loading booking..." state.
      await openBookingDetail(bookingId);
      setStatus(document.getElementById('bookingStatusMessage'), `Status updated to "${STATUS_LABELS[updatedStatus] || updatedStatus}".`, 'success');
      loadDashboard();
      loadBookings(true);
      return;
    }
    if (result.kind === 'unauthenticated') {
      closeBookingDetail();
      exitToLogin('Your session has expired. Please sign in again.');
      return;
    }
    if (result.kind === 'forbidden') {
      closeBookingDetail();
      exitToForbidden();
      return;
    }
    if (result.kind === 'error' && result.status === 409) {
      setStatus(messageEl, (result.data && result.data.message) || 'That status change isn\'t allowed from the booking\'s current state.', 'error');
      return;
    }
    setStatus(messageEl, (result.data && result.data.message) || 'Could not update the booking\'s status. Please try again.', 'error');
  }

  async function openBookingDetail(bookingId) {
    currentBookingId = bookingId;
    bookingDetailOverlay.hidden = false;
    bookingDetailBody.hidden = true;
    setStatus(bookingDetailStatus, 'Loading booking...');

    const result = await adminFetch(`/admin/bookings/${encodeURIComponent(bookingId)}`);
    if (currentBookingId !== bookingId) return; // overlay closed / navigated away while loading

    if (result.kind === 'ok') {
      renderBookingDetail(result.data);
      bookingDetailBody.hidden = false;
      setStatus(bookingDetailStatus, '');
    } else if (result.kind === 'error' && result.status === 404) {
      setStatus(bookingDetailStatus, 'This booking could not be found.', 'error');
    } else {
      reportViewError(bookingDetailStatus, result, 'Could not load this booking right now.');
    }
  }

  // ==================================================================
  // PAYMENTS - GET /admin/payments
  // ==================================================================
  const paymentsStatus = document.getElementById('paymentsStatus');
  const paymentsTableWrap = document.getElementById('paymentsTableWrap');
  const paymentsTableBody = document.getElementById('paymentsTableBody');
  const paymentsLoadMoreBtn = document.getElementById('paymentsLoadMoreBtn');
  const paymentsFilters = document.getElementById('paymentsFilters');
  const paymentsFilterStatus = document.getElementById('paymentsFilterStatus');
  const paymentsFilterDate = document.getElementById('paymentsFilterDate');
  const paymentsFilterBookingId = document.getElementById('paymentsFilterBookingId');
  const paymentsFilterClearBtn = document.getElementById('paymentsFilterClearBtn');

  let paymentsItems = [];
  let paymentsCursor = null;
  let paymentsFilterState = {};

  function paymentRow(item) {
    return `
      <tr>
        <td data-label="Payment" title="${escapeHtml(item.id)}">${escapeHtml(shortId(item.id))}</td>
        <td data-label="Booking" class="admin-row-clickable" data-booking-id="${escapeHtml(item.bookingId)}" title="${escapeHtml(item.bookingId)}">${escapeHtml(bookingRef(item.bookingNumber, item.bookingId))}</td>
        <td data-label="Provider">${escapeHtml(item.provider)}</td>
        <td data-label="Amount">${escapeHtml(formatBookingPrice(item.amountInr))} ${escapeHtml(item.currency)}</td>
        <td data-label="Status"><span class="admin-payment-pill ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></td>
        <td data-label="Order / Txn ID" class="admin-td-wrap" title="${escapeHtml(item.providerOrderId)}${item.providerTransactionId ? ' / ' + escapeHtml(item.providerTransactionId) : ''}">${escapeHtml(shortId(item.providerOrderId))}${item.providerTransactionId ? ' / ' + escapeHtml(shortId(item.providerTransactionId)) : ''}</td>
        <td data-label="Created">${escapeHtml(formatDateTimeDisplay(item.createdAt))}</td>
        <td data-label="Paid">${item.paidAt ? escapeHtml(formatDateTimeDisplay(item.paidAt)) : '—'}</td>
      </tr>
    `;
  }

  function renderPaymentsTable() {
    paymentsTableBody.innerHTML = paymentsItems.map(paymentRow).join('');
    paymentsTableWrap.hidden = paymentsItems.length === 0;
    setStatus(paymentsStatus, paymentsItems.length === 0 ? 'No payments match these filters.' : '');
  }

  async function loadPayments(reset) {
    if (reset) {
      paymentsItems = [];
      paymentsCursor = null;
      paymentsTableWrap.hidden = true;
    }
    setStatus(paymentsStatus, 'Loading payments...');
    paymentsLoadMoreBtn.hidden = true;

    const query = buildQuery(Object.assign({}, paymentsFilterState, { limit: 20, cursor: paymentsCursor || undefined }));
    const result = await adminFetch(`/admin/payments${query}`);
    if (result.kind !== 'ok') {
      reportViewError(paymentsStatus, result, 'Could not load payments right now.');
      return;
    }

    paymentsItems = paymentsItems.concat(result.data.items || []);
    paymentsCursor = result.data.nextCursor || null;
    renderPaymentsTable();
    paymentsLoadMoreBtn.hidden = !paymentsCursor;
  }

  paymentsFilters.addEventListener('submit', (e) => {
    e.preventDefault();
    const bookingId = paymentsFilterBookingId.value.trim();
    paymentsFilterState = {
      status: paymentsFilterStatus.value || undefined,
      date: paymentsFilterDate.value || undefined,
      bookingId: bookingId || undefined
    };
    loadPayments(true);
  });

  paymentsFilterClearBtn.addEventListener('click', () => {
    paymentsFilterStatus.value = '';
    paymentsFilterDate.value = '';
    paymentsFilterBookingId.value = '';
    paymentsFilterState = {};
    loadPayments(true);
  });

  paymentsLoadMoreBtn.addEventListener('click', () => loadPayments(false));

  paymentsTableBody.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-booking-id]');
    if (cell) openBookingDetail(cell.dataset.bookingId);
  });

  // ==================================================================
  // SIMULATORS - GET /admin/simulators
  // ==================================================================
  const simulatorsStatus = document.getElementById('simulatorsStatus');
  const simulatorsBoard = document.getElementById('simulatorsBoard');
  const simulatorsDateInput = document.getElementById('simulatorsDate');
  const simulatorsRefreshBtn = document.getElementById('simulatorsRefreshBtn');

  function simulatorEntry(entry) {
    return `
      <div class="admin-simulator-entry">
        <div class="admin-simulator-entry-row">
          <span title="${escapeHtml(entry.bookingId)}">${escapeHtml(bookingRef(entry.bookingNumber, entry.bookingId))}</span>
          <span class="admin-blocks-pill ${entry.blocksCapacity ? 'blocking' : 'free'}">${entry.blocksCapacity ? 'Blocking' : 'Free'}</span>
        </div>
        <div class="admin-simulator-entry-time">
          ${escapeHtml(formatDateTimeDisplay(entry.scheduledStartAt))} - booking: ${escapeHtml(formatBookingStatus(entry.bookingStatus))}, allocation: ${escapeHtml(entry.allocationStatus)}
        </div>
      </div>
    `;
  }

  function simulatorColumn(sim) {
    return `
      <div class="admin-simulator-column">
        <div class="admin-simulator-column-head">
          <span class="admin-simulator-code">${escapeHtml(sim.code)}</span>
          <span class="admin-simulator-type">${escapeHtml(sim.type)}</span>
        </div>
        ${sim.entries.length ? sim.entries.map(simulatorEntry).join('') : '<p class="admin-simulator-empty">No allocations for this day.</p>'}
      </div>
    `;
  }

  async function loadSimulators() {
    const date = simulatorsDateInput.value || todayIstDate();
    simulatorsDateInput.value = date;
    setStatus(simulatorsStatus, 'Loading simulator board...');
    simulatorsBoard.hidden = true;

    const result = await adminFetch(`/admin/simulators${buildQuery({ date })}`);
    if (result.kind !== 'ok') {
      reportViewError(simulatorsStatus, result, 'Could not load the simulator board right now.');
      return;
    }

    simulatorsBoard.innerHTML = (result.data.simulators || []).map(simulatorColumn).join('');
    simulatorsBoard.hidden = false;
    setStatus(simulatorsStatus, '');
  }

  simulatorsRefreshBtn.addEventListener('click', loadSimulators);
  simulatorsDateInput.addEventListener('change', loadSimulators);

  // ------------------------------------------------------------------
  simulatorsDateInput.value = todayIstDate();
  resumeSessionOnLoad();
})();
