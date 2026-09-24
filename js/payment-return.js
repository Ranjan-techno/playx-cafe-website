// payment-return.html - where PhonePe sends the customer after checkout.
//
// The URL is never evidence of payment: nothing here reads success=/code=/status= style
// parameters. The only inputs are (a) which booking to ask about (PlayXPayments.resolveBookingId:
// the backend-set ?bookingId= or the id stashed before we left for PhonePe - an identifier only)
// and (b) what GET /payments/{bookingId}/status answers - GET /payments/production/{bookingId}/status
// when this page is served from playxcafe.com (the PRODUCTION return URL), chosen from the page's
// hostname by js/api-routes.js, never from a URL parameter. Requires js/aws-config.js,
// js/cognito-auth.js, js/api-routes.js and js/payments.js loaded first.

(function () {
  const el = (id) => document.getElementById(id);
  const card = el('paymentReturnCard');
  const iconEl = el('paymentReturnIcon');
  const titleEl = el('paymentReturnTitle');
  const bookingEl = el('paymentReturnBooking');
  const messageEl = el('paymentReturnMessage');
  const detailEl = el('paymentReturnDetail');
  const errorEl = el('paymentReturnError');
  const primaryBtn = el('paymentReturnPrimaryBtn');
  const bookingsLink = el('paymentReturnBookingsLink');
  const rebookLink = el('paymentReturnRebookLink');

  const ICONS = { success: '✓', pending: '…', failed: '!', failed_final: '!', hold_expired: '!', manual_review: 'i', error: '!' };
  const AUTO_POLL_INTERVAL_MS = 5000;
  const AUTO_POLL_MAX = 6;

  const client = PlayXPayments.getBrowserClient();

  let bookingId = null;
  let pollTimer = null;
  let pollCount = 0;
  let primaryHandler = null;

  function setPrimary(label, handler) {
    primaryHandler = handler;
    primaryBtn.textContent = label || '';
    primaryBtn.hidden = !label;
    primaryBtn.disabled = false;
  }

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function render(view) {
    card.dataset.state = view.state;
    iconEl.textContent = ICONS[view.state] || '';
    titleEl.textContent = view.title;
    bookingEl.textContent = view.bookingLabel || '';
    bookingEl.hidden = !view.bookingLabel;
    messageEl.textContent = view.message;
    detailEl.textContent = view.detail || '';
    detailEl.hidden = !view.detail;
    bookingsLink.hidden = !(view.state === 'success' || view.state === 'manual_review');
    rebookLink.hidden = !(view.state === 'hold_expired' || view.state === 'failed_final');
    if (view.action === 'retry') setPrimary('TRY PAYMENT AGAIN', retryPayment);
    else if (view.action === 'check') setPrimary('CHECK PAYMENT STATUS', () => checkStatus({ manual: true }));
    else setPrimary(null, null);
  }

  // A problem with the request itself (expired session, network, ...) rather than a payment outcome.
  function renderRequestError(result) {
    card.dataset.state = 'error';
    iconEl.textContent = ICONS.error;
    detailEl.hidden = true;
    bookingEl.hidden = true;
    if (result.kind === 'session_expired') {
      titleEl.textContent = 'Please Log In Again';
      messageEl.textContent = result.message;
      showError('');
      setPrimary(null, null);
      bookingsLink.textContent = 'Verify Email & View My Bookings';
      bookingsLink.hidden = false;
    } else if (result.kind === 'not_found') {
      titleEl.textContent = 'Booking Not Found';
      messageEl.textContent = result.message;
      showError('');
      setPrimary(null, null);
      bookingsLink.hidden = false;
    } else if (result.kind === 'not_configured') {
      titleEl.textContent = 'Payment Status Unavailable';
      messageEl.textContent = result.message;
      showError('');
      setPrimary(null, null);
    } else {
      // Status unknown: say only that, and never imply paid / failed / safe.
      titleEl.textContent = 'Payment Status Unavailable';
      messageEl.textContent = "We couldn't verify your payment status right now.";
      detailEl.textContent = 'Please check again before starting another payment.';
      detailEl.hidden = false;
      showError('');
      setPrimary('CHECK PAYMENT STATUS', () => checkStatus({ manual: true }));
    }
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function checkStatus({ manual = false } = {}) {
    stopPolling();
    showError('');
    primaryBtn.disabled = true;
    if (manual) pollCount = 0;

    const result = await client.getPaymentStatus(bookingId);
    if (!result.ok) {
      renderRequestError(result);
      return;
    }
    const view = PlayXPayments.describePaymentStatus(result.status);
    render(view);
    // A finished payment (or one that can never resume) no longer needs its stashed context.
    if (view.terminal) PlayXPayments.clearCheckoutContext(window.sessionStorage);

    if (view.state === 'pending' && pollCount < AUTO_POLL_MAX) {
      pollCount += 1;
      pollTimer = setTimeout(() => checkStatus(), AUTO_POLL_INTERVAL_MS);
    }
  }

  async function retryPayment() {
    showError('');
    primaryBtn.disabled = true;
    primaryBtn.textContent = 'REDIRECTING TO PHONEPE…';
    const result = await client.startPayment(bookingId);
    if (result.ok || result.kind === 'busy') return; // navigating away
    // Retry was refused (e.g. the hold expired in the meantime): re-ask what the state is now
    // rather than leaving a stale "try again" button - but keep the specific reason visible.
    if (result.kind === 'session_expired') {
      renderRequestError(result);
      return;
    }
    await checkStatus({ manual: true });
    showError(result.message);
  }

  primaryBtn.addEventListener('click', () => { if (primaryHandler) primaryHandler(); });

  function init() {
    if (!CognitoAuth.isConfigured) {
      renderRequestError({ kind: 'not_configured', message: 'Payments are not set up yet.' });
      return;
    }
    bookingId = PlayXPayments.resolveBookingId(window.location.search, window.sessionStorage);
    if (!bookingId) {
      renderRequestError(PlayXPayments.describeMissingBooking());
      return;
    }
    checkStatus({ manual: true });
  }

  init();
})();
