// Hostname -> backend environment routing for the customer booking/payment flow - the ONE place
// that decides whether this page talks to the SANDBOX or the PRODUCTION booking/payment routes.
//
//   playxcafe.com / www.playxcafe.com   PRODUCTION   POST /bookings/production
//                                                    GET  /bookings/production/me
//                                                    POST /payments/production/start
//                                                    GET  /payments/production/{id}/status
//   everything else (staging.playxcafe.com, SANDBOX      POST /bookings
//   localhost, previews, unknown hosts)              GET  /bookings/me
//                                                    POST /payments/start
//                                                    GET  /payments/{id}/status
//
// My Bookings is environment-isolated on the SERVER: GET /bookings/production/me returns only
// PRODUCTION bookings and GET /bookings/me only SANDBOX ones (the environment is hard-coded per
// Lambda), so nothing is downloaded and then hidden here.
//
// Trust model:
//   - The ONLY input is the page's own hostname. No query parameter, hash, storage value, cookie
//     or API response can select or override the environment. An unknown host falls back to
//     SANDBOX, never to PRODUCTION.
//   - This is routing only, not authorization. Every PRODUCTION route is independently gated
//     server-side (kill switches + the production access mode - TESTER allowlist or PUBLIC -
//     booking ownership, environment matching); calling it from the "wrong" host gains nothing.
//   - No PhonePe credential, secret name or tester id lives here or anywhere in frontend JS.
//
// DOM-free and exported for tests (tests/api-routes.test.js) via module.exports; in the browser
// it is the plain global `PlayXApiRoutes`, loaded before js/payments.js and js/script.js.

(function (root) {
  const PRODUCTION_HOSTNAMES = Object.freeze(['playxcafe.com', 'www.playxcafe.com']);

  // Hosts on which the PhonePe payment UI (Pay buttons, payment step, My Bookings actions) is
  // shown at all. Anything else (previews, unknown hosts) books against SANDBOX with no payment UI.
  const PAYMENT_UI_HOSTNAMES = Object.freeze([...PRODUCTION_HOSTNAMES, 'staging.playxcafe.com', 'localhost', '127.0.0.1']);

  const ROUTES = Object.freeze({
    SANDBOX: Object.freeze({
      environment: 'SANDBOX',
      createBooking: '/bookings',
      myBookings: '/bookings/me',
      startPayment: '/payments/start',
      paymentStatus: (bookingId) => `/payments/${encodeURIComponent(bookingId)}/status`
    }),
    PRODUCTION: Object.freeze({
      environment: 'PRODUCTION',
      createBooking: '/bookings/production',
      myBookings: '/bookings/production/me',
      startPayment: '/payments/production/start',
      paymentStatus: (bookingId) => `/payments/production/${encodeURIComponent(bookingId)}/status`
    })
  });

  function normalizeHostname(hostname) {
    return typeof hostname === 'string' ? hostname.toLowerCase() : '';
  }

  /** 'PRODUCTION' only for an exact production hostname; 'SANDBOX' for everything else. */
  function environmentForHostname(hostname) {
    return PRODUCTION_HOSTNAMES.includes(normalizeHostname(hostname)) ? 'PRODUCTION' : 'SANDBOX';
  }

  function routesForHostname(hostname) {
    return ROUTES[environmentForHostname(hostname)];
  }

  function isPaymentUiHostname(hostname) {
    return PAYMENT_UI_HOSTNAMES.includes(normalizeHostname(hostname));
  }

  /** Browser-only: routes for the current page. Reads window.location.hostname and nothing else. */
  function currentRoutes() {
    return routesForHostname(root.location && root.location.hostname);
  }

  const api = {
    PRODUCTION_HOSTNAMES,
    PAYMENT_UI_HOSTNAMES,
    ROUTES,
    environmentForHostname,
    routesForHostname,
    isPaymentUiHostname,
    currentRoutes
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlayXApiRoutes = api;
})(typeof window !== 'undefined' ? window : globalThis);
