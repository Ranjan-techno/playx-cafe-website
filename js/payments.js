// Customer payment client - POST /payments/start and GET /payments/{bookingId}/status
// (backend/src/handlers/payment-start.ts, payment-status.ts), or their PRODUCTION twins
// POST /payments/production/start and GET /payments/production/{bookingId}/status on
// playxcafe.com - the route set is chosen from the page's hostname by js/api-routes.js, never by
// anything in the request/URL. Shared by index.html (the post-booking payment step and My
// Bookings) and payment-return.html.
//
// Trust model, kept deliberately narrow:
//   - The backend is the only authority on amount, booking state and payment state. Nothing here
//     sends an amount/status; POST /payments/start carries { bookingId } and nothing else.
//   - Coming back from PhonePe proves nothing. The return page only ever believes what
//     GET /payments/{bookingId}/status says (describePaymentStatus() below).
//   - No PhonePe credentials exist in the frontend. The JWT comes from CognitoAuth at call time,
//     is only ever put in the Authorization header, and is never logged or stored by this file.
//   - The redirect URL is used once, for window.location.href, and is never logged or stored.
//
// The DOM-free core is exported for tests (tests/payments.test.js) via module.exports; in the
// browser it is the plain global `PlayXPayments`, like every other script here.

(function (root) {
  // sessionStorage key holding { bookingId, startedAt } across the trip to PhonePe and back. The
  // booking id is an identifier only - status is always re-fetched from the backend.
  const CHECKOUT_STORAGE_KEY = 'playx_payment_checkout';

  // A checkout context older than this is discarded (the customer wandered off, or the tab sat
  // open across sessions): its bookingId is never used. A valid ?bookingId= on the return URL is
  // unaffected - that comes from the server-controlled redirect.
  const CHECKOUT_MAX_AGE_MS = 2 * 60 * 60 * 1000;

  // Hostname -> environment routing (js/api-routes.js): the global in the browser, required in tests.
  const ApiRoutes = root.PlayXApiRoutes || (typeof require === 'function' ? require('./api-routes.js') : null);

  // PhonePe payment UI gate: staging/local development (SANDBOX routes) and playxcafe.com /
  // www.playxcafe.com (PRODUCTION routes, which the backend gates by its production access mode).
  // The host list lives in js/api-routes.js next to the routing it implies.
  function isPaymentUiEnabled(hostname) {
    return ApiRoutes.isPaymentUiHostname(hostname);
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isUuid(value) {
    return typeof value === 'string' && UUID_RE.test(value);
  }

  // Same rule as the backend's isSafeCheckoutRedirect(): defense in depth - an https URL on a
  // phonepe.com host is the only thing this page will ever navigate to.
  function isSafeCheckoutRedirect(raw) {
    try {
      const url = new URL(raw);
      return url.protocol === 'https:' && (url.hostname === 'phonepe.com' || url.hostname.endsWith('.phonepe.com'));
    } catch (err) {
      return false;
    }
  }

  // ---- Error mapping -------------------------------------------------------------------------
  // Fixed, customer-safe sentences only. Nothing from a response body's `message` is ever shown:
  // the backend already sanitizes it, but the copy here shouldn't depend on that staying true.
  const ERROR_COPY = {
    session_expired: 'Your session has expired. Please verify your email again to continue.',
    not_permitted: 'Online payments are not available for this account yet. Please contact Play X Cafe.',
    not_found: "We couldn't find this booking. Please check My Bookings or contact Play X Cafe.",
    hold_expired: 'This reservation has expired. Please make a new booking.',
    already_paid: 'This booking has already been paid.',
    not_payable: 'This booking can no longer be paid for.',
    in_progress: 'A payment is already in progress for this booking. Please wait a moment and check the payment status.',
    capacity_unavailable: 'That time slot is no longer available. Please make a new booking.',
    checkout_window_closed: 'There is not enough time left to complete a payment for this booking.',
    provider_rejected: "PhonePe couldn't process this payment request. Please try again, or contact Play X Cafe.",
    provider_unavailable: 'PhonePe is temporarily unavailable. Please try again in a few minutes.',
    network: "We couldn't reach Play X Cafe. Check your connection and try again.",
    unknown: 'Something went wrong. Please try again.'
  };

  // Maps an HTTP status + the backend's stable `error` code to one of the kinds above.
  function classifyError(httpStatus, code) {
    if (httpStatus === 401) return 'session_expired';
    if (httpStatus === 403) return 'not_permitted';
    if (httpStatus === 404) return 'not_found';
    if (httpStatus === 409) {
      switch (code) {
        case 'hold_expired': return 'hold_expired';
        case 'booking_already_paid': return 'already_paid';
        case 'payment_start_in_progress': return 'in_progress';
        case 'capacity_unavailable': return 'capacity_unavailable';
        case 'checkout_window_closed': return 'checkout_window_closed';
        default: return 'not_payable';
      }
    }
    if (httpStatus === 502) return 'provider_rejected';
    if (httpStatus === 503) return 'provider_unavailable';
    return 'unknown';
  }

  function failure(kind) {
    return { ok: false, kind, message: ERROR_COPY[kind] || ERROR_COPY.unknown };
  }

  // ---- Checkout context ----------------------------------------------------------------------
  function saveCheckoutContext(storage, bookingId) {
    try {
      storage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify({ bookingId, startedAt: Date.now() }));
    } catch (err) {
      // Private-mode storage failure: the return URL's bookingId (see resolveBookingId) is the fallback.
    }
  }

  function readCheckoutContext(storage, now = Date.now()) {
    try {
      const parsed = JSON.parse(storage.getItem(CHECKOUT_STORAGE_KEY));
      if (!parsed || !isUuid(parsed.bookingId)) return null;
      const age = now - parsed.startedAt;
      if (typeof parsed.startedAt !== 'number' || !(age >= 0 && age <= CHECKOUT_MAX_AGE_MS)) {
        clearCheckoutContext(storage);
        return null;
      }
      return parsed;
    } catch (err) {
      return null;
    }
  }

  function clearCheckoutContext(storage) {
    try {
      storage.removeItem(CHECKOUT_STORAGE_KEY);
    } catch (err) {
      // nothing to clean up
    }
  }

  // Which booking is the return page about? The backend puts `?bookingId=` on PhonePe's return
  // URL (payment-start.ts) and we also stash the id before redirecting. Either is only an
  // IDENTIFIER: whatever it names, GET /payments/{id}/status (or its PRODUCTION twin) enforces
  // ownership and reports the authoritative state, and no other URL parameter (success=true,
  // code=..., environment=..., etc.) is ever read.
  function resolveBookingId(search, storage, now = Date.now()) {
    let fromUrl = null;
    try {
      fromUrl = new URLSearchParams(search).get('bookingId');
    } catch (err) {
      fromUrl = null;
    }
    if (isUuid(fromUrl)) return fromUrl.toLowerCase();
    const ctx = readCheckoutContext(storage, now);
    return ctx ? ctx.bookingId : null;
  }

  // ---- Client --------------------------------------------------------------------------------
  // Everything environment-specific is injected so the same code runs in the browser and in tests.
  //   routes      -> PlayXApiRoutes.ROUTES.SANDBOX | .PRODUCTION (defaults to SANDBOX; the
  //                  browser client passes the hostname's set - see getBrowserClient)
  //   getToken()  -> Promise<string|null>  (CognitoAuth.getAccessToken)
  //   redirect(u) -> full-page navigation  (window.location.href = u)
  function createPaymentClient({ apiBaseUrl, routes = ApiRoutes.ROUTES.SANDBOX, getToken, fetchImpl, storage, redirect }) {
    // Double-click / double-tap protection: one start request in flight at a time, per client,
    // across every button that shares it. (Backend idempotency - one reusable attempt per booking -
    // is the real protection; this only keeps the UI from sending duplicates.)
    let startInFlight = false;
    // Set once this client has sent the page to PhonePe. If the browser later restores the page
    // from its back/forward cache, the "Redirecting..." state is stale (see getBrowserClient).
    let redirectIssued = false;

    async function authorizedFetch(path, init) {
      let token;
      try {
        token = await getToken();
      } catch (err) {
        token = null; // never log the error: it may carry token material
      }
      if (!token) return { error: failure('session_expired') };
      let response;
      try {
        response = await fetchImpl(`${apiBaseUrl}${path}`, {
          ...init,
          headers: { ...(init && init.headers), Authorization: `Bearer ${token}` }
        });
      } catch (err) {
        return { error: failure('network') };
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { error: failure(classifyError(response.status, body && body.error)) };
      }
      return { body };
    }

    // Starts checkout for one booking and, on success, leaves the page for PhonePe. Resolves
    // { ok: true } only once the redirect has been issued; { ok: false, kind, message } otherwise
    // (including { kind: 'busy' } when a start is already in flight - callers just ignore that).
    async function startPayment(bookingId) {
      if (startInFlight) return { ok: false, kind: 'busy', message: '' };
      if (!isUuid(bookingId)) return failure('not_found');
      startInFlight = true;
      let redirected = false;
      try {
        const { body, error } = await authorizedFetch(routes.startPayment, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookingId })
        });
        if (error) return error;
        if (!body || typeof body.redirectUrl !== 'string' || !isSafeCheckoutRedirect(body.redirectUrl)) {
          return failure('provider_rejected');
        }
        saveCheckoutContext(storage, bookingId);
        redirect(body.redirectUrl);
        redirected = true;
        redirectIssued = true;
        return { ok: true };
      } catch (err) {
        return failure('unknown');
      } finally {
        // On success the page is navigating away: leave the guard set so the button can't start a
        // second checkout in that window. Every other outcome re-arms it.
        if (!redirected) startInFlight = false;
      }
    }

    async function getPaymentStatus(bookingId) {
      if (!isUuid(bookingId)) return failure('not_found');
      const { body, error } = await authorizedFetch(routes.paymentStatus(bookingId), {
        method: 'GET'
      });
      if (error) return error;
      return { ok: true, status: body };
    }

    return { startPayment, getPaymentStatus, hasRedirected: () => redirectIssued };
  }

  // A page restored from the back/forward cache after we sent it to PhonePe still shows a disabled
  // "Redirecting..." button and a set in-flight guard. Reloading re-asks the backend for the real
  // state instead (success is only ever what the status endpoint says).
  function shouldReloadOnPageShow(event, client) {
    return !!(event && event.persisted && client && client.hasRedirected());
  }

  // ---- Status -> customer-facing view --------------------------------------------------------
  // Turns the backend's { outcome, bookingStatus, canRetry, bookingNumber } into what to show.
  // `state` names the layout; `action` is the one primary button ('retry' | 'check' | null).
  // Only outcome 'confirmed' - which the backend derives from a PAID payment AND a confirmed
  // booking - ever produces the success view. Anything unrecognised falls back to "processing"
  // rather than guessing success or failure.
  function describePaymentStatus(status) {
    const bookingLabel = status && typeof status.bookingNumber === 'number' ? `Booking #${status.bookingNumber}` : null;
    const outcome = status && status.outcome;

    if (outcome === 'confirmed' && status.bookingStatus === 'confirmed') {
      return {
        state: 'success', title: 'Payment Successful', bookingLabel,
        message: 'Your race is confirmed.', action: null, terminal: true
      };
    }
    if (outcome === 'refund_required') {
      return {
        state: 'manual_review', title: 'Payment Received', bookingLabel,
        message: 'Payment received, but we could not confirm the booking.',
        detail: 'Please contact Play X Cafe support. Your payment will be reviewed.',
        action: null, terminal: true
      };
    }
    if (outcome === 'hold_expired') {
      return {
        state: 'hold_expired', title: 'Reservation Expired', bookingLabel,
        message: 'Your reservation hold expired before payment was completed.',
        detail: 'Please make a new booking to reserve your race.',
        action: null, terminal: true
      };
    }
    if (outcome === 'failed' || outcome === 'expired' || outcome === 'not_started') {
      if (status.canRetry) {
        return {
          state: 'failed', title: 'Payment Not Completed', bookingLabel,
          message: 'Your payment was not completed. You can try again.',
          action: 'retry', terminal: false
        };
      }
      return {
        state: 'failed_final', title: 'Payment Not Completed', bookingLabel,
        message: 'Your payment was not completed and this booking can no longer be paid for.',
        detail: 'Please make a new booking, or contact Play X Cafe if you were charged.',
        action: null, terminal: true
      };
    }
    // 'pending', a paid-but-not-yet-confirmed row, or anything unexpected.
    return {
      state: 'pending', title: 'Payment Processing', bookingLabel,
      message: "We're confirming your payment with PhonePe.",
      action: 'check', terminal: false
    };
  }

  // What My Bookings should offer on a pending booking, from the same status payload.
  // { label, action: 'pay' | 'check' | 'retry' | null, note }
  function describeBookingPaymentAction(status) {
    const view = describePaymentStatus(status);
    if (status && status.outcome === 'not_started' && status.canRetry) {
      return { label: 'Pay Now', action: 'pay', note: '' };
    }
    switch (view.state) {
      case 'success': return { label: 'Confirmed / Paid', action: null, note: '' };
      case 'pending': return { label: 'Payment Processing', action: 'check', note: '' };
      case 'failed': return { label: 'Payment Failed – Retry', action: 'retry', note: '' };
      case 'hold_expired': return { label: '', action: null, note: 'Reservation expired. Please make a new booking.' };
      case 'manual_review':
        return { label: '', action: null, note: 'Payment received, but we could not confirm the booking. Please contact Play X Cafe support.' };
      default: return { label: '', action: null, note: 'This booking can no longer be paid for.' };
    }
  }

  // What My Bookings shows when GET /payments/{id}/status itself fails. The payment state is
  // UNKNOWN, so this never offers Pay Now/Retry - only a re-check (or nothing, for a dead session
  // or unknown booking). { label, action: 'check' | null, note }
  function describeStatusFailure(result) {
    const kind = result && result.kind;
    if (kind === 'session_expired') return { label: '', action: null, note: ERROR_COPY.session_expired };
    if (kind === 'not_found') return { label: '', action: null, note: ERROR_COPY.not_found };
    return { label: 'CHECK AGAIN', action: 'check', note: 'Unable to verify payment status.' };
  }

  // payment_start_in_progress: another start is underway, so the state is "processing", not
  // "retry". Both the post-booking step and My Bookings switch to a status check.
  function describeStartInProgress() {
    return { label: 'CHECK PAYMENT STATUS', action: 'check', note: 'Payment Processing' };
  }

  // One shared client per page, wired to the real globals, so the booking step and My Bookings
  // share a single double-click guard. Browser-only (needs AWS_CONFIG/CognitoAuth/window). Its
  // routes come from this page's hostname only (PlayXApiRoutes.currentRoutes()).
  let browserClient = null;
  function getBrowserClient() {
    if (!browserClient) {
      browserClient = createPaymentClient({
        apiBaseUrl: AWS_CONFIG.apiBaseUrl,
        routes: ApiRoutes.currentRoutes(),
        getToken: () => (CognitoAuth.isConfigured ? CognitoAuth.getAccessToken() : Promise.resolve(null)),
        fetchImpl: (...args) => window.fetch(...args),
        storage: window.sessionStorage,
        redirect: (url) => { window.location.href = url; }
      });
      const client = browserClient;
      if (typeof window.addEventListener === 'function') {
        window.addEventListener('pageshow', (event) => {
          if (shouldReloadOnPageShow(event, client)) window.location.reload();
        });
      }
    }
    return browserClient;
  }

  // No booking id anywhere (opened the page directly, storage cleared, ...).
  function describeMissingBooking() {
    return failure('not_found');
  }

  const api = {
    CHECKOUT_STORAGE_KEY,
    CHECKOUT_MAX_AGE_MS,
    isPaymentUiEnabled,
    describeStatusFailure,
    describeStartInProgress,
    ERROR_COPY,
    isUuid,
    isSafeCheckoutRedirect,
    classifyError,
    saveCheckoutContext,
    readCheckoutContext,
    clearCheckoutContext,
    resolveBookingId,
    describeMissingBooking,
    createPaymentClient,
    shouldReloadOnPageShow,
    getBrowserClient,
    describePaymentStatus,
    describeBookingPaymentAction
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlayXPayments = api;
})(typeof window !== 'undefined' ? window : globalThis);
