// DOM-free helper for js/admin.js: the Stage 3A.2 "New Walk-in Booking" workflow on admin.html.
// Everything here is pure (no DOM, no fetch) so tests/admin-walk-in.test.js can cover it directly.
//
// TRUST: this file only ever shapes what the admin sees and what the browser sends. The backend
// (backend/src/lib/walk-in-booking.ts) derives price, duration, racers, simulator type, the
// simulators themselves, booking status, payment amount and environment server-side and never
// reads any of those from the request - so buildWalkInPayload() below whitelists exactly the
// Stage 3A.1 contract fields and nothing else.
//
// INVENTORY: a walk-in is always real venue business, so it is always checked against PRODUCTION
// occupancy - GET /availability/production, unconditionally. This deliberately does NOT go through
// js/api-routes.js's hostname-based route selection (which picks the SANDBOX route on staging).
(function (root) {
  const PAYMENT_METHODS = ['CASH', 'UPI', 'CARD', 'COMPLIMENTARY'];
  const PAYMENT_METHOD_LABELS = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', COMPLIMENTARY: 'Complimentary' };
  // Mirrors walk-in-booking.ts's REFERENCE_METHODS / PAYMENT_REFERENCE_* - a UX hint only; the
  // backend rejects a reference on any other method and re-validates the format itself.
  const REFERENCE_METHODS = ['UPI', 'CARD'];
  const PAYMENT_REFERENCE_MAX_LENGTH = 64;
  const PAYMENT_REFERENCE_RE = /^[A-Za-z0-9 ._/-]+$/;

  const AVAILABILITY_PATH = '/availability/production';
  const WALK_IN_PATH = '/admin/bookings/walk-in';

  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isSessionProduct(product) {
    return !!product && product.productType === 'session' && typeof product.productCode === 'string';
  }

  // GET /products returns every active product, race passes included - only sessions can be
  // booked at the counter.
  function sessionProducts(products) {
    return Array.isArray(products) ? products.filter(isSessionProduct) : [];
  }

  function formatInr(amount) {
    return '₹' + Number(amount).toLocaleString('en-IN');
  }

  function simulatorTypeLabel(type) {
    if (!type) return '—';
    return String(type).charAt(0).toUpperCase() + String(type).slice(1);
  }

  function racersLabel(racers) {
    const n = Number(racers);
    return `${n} ${n === 1 ? 'racer' : 'racers'}`;
  }

  // "Solo Pro - Motion · 30 min · Motion · 1 racer · ₹1,000" - every value straight from the
  // server catalog row.
  function productOptionLabel(product) {
    return [
      product.name,
      `${product.durationMinutes} min`,
      simulatorTypeLabel(product.simulatorType),
      racersLabel(product.racers),
      formatInr(product.priceInr)
    ].join(' · ');
  }

  function availabilityPath(productCode, date) {
    return `${AVAILABILITY_PATH}?productCode=${encodeURIComponent(productCode)}&date=${encodeURIComponent(date)}`;
  }

  function paymentReferenceApplies(method) {
    return REFERENCE_METHODS.indexOf(method) !== -1;
  }

  function paymentMethodLabel(method) {
    return PAYMENT_METHOD_LABELS[method] || method;
  }

  // What the counter actually collects - mirrors walk-in-booking.ts's counterAmountInr() for the
  // review preview only; the success screen always shows the server's own payment.amountInr.
  function previewAmountInr(method, listPriceInr) {
    return method === 'COMPLIMENTARY' ? 0 : Number(listPriceInr);
  }

  // YYYY-MM-DD strings compare correctly as strings.
  function isPastDate(date, todayIst) {
    return typeof date === 'string' && date !== '' && date < todayIst;
  }

  // GET /availability enumerates the whole opening day, but POST /admin/bookings/walk-in rejects a
  // start time that has already passed ("Start now" is a later stage) - so on today's date, hide
  // slots at or before the current IST minute. UX only; the backend re-checks against its own clock.
  function filterUpcomingSlots(slots, date, todayIst, nowIstMinutes) {
    const list = Array.isArray(slots) ? slots.filter((s) => typeof s === 'string' && /^\d{2}:\d{2}$/.test(s)) : [];
    if (date !== todayIst) return list;
    return list.filter((slot) => {
      const [h, m] = slot.split(':').map(Number);
      return h * 60 + m > nowIstMinutes;
    });
  }

  function trimOrEmpty(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  // Client-side checks for obvious mistakes before the review step. Returns the first problem as
  // { field, message }, or null. The backend remains authoritative for every rule here.
  function validateWalkInForm(form, todayIst) {
    if (!trimOrEmpty(form.name)) return { field: 'name', message: 'Enter the customer\'s name.' };
    // Same shapes backend/src/lib/phone.ts's normalizeIndianPhone() accepts: 10 digits, 0 + 10,
    // or 91 + 10, ignoring any non-digit characters.
    if (!trimOrEmpty(form.phone)) return { field: 'phone', message: 'Enter the customer\'s phone number.' };
    const phoneDigits = trimOrEmpty(form.phone).replace(/\D/g, '');
    if (!/^(?:0|91)?\d{10}$/.test(phoneDigits)) {
      return { field: 'phone', message: 'Enter a valid 10-digit Indian mobile number.' };
    }
    const email = trimOrEmpty(form.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { field: 'email', message: 'Enter a valid email address, or leave it blank.' };
    }
    if (!form.productCode) return { field: 'product', message: 'Choose a package.' };
    if (!form.bookingDate) return { field: 'date', message: 'Choose a date.' };
    if (isPastDate(form.bookingDate, todayIst)) return { field: 'date', message: 'That date is in the past.' };
    if (!form.startTime) return { field: 'time', message: 'Choose an available time.' };
    if (PAYMENT_METHODS.indexOf(form.paymentMethod) === -1) {
      return { field: 'payment', message: 'Choose a payment method.' };
    }
    const reference = trimOrEmpty(form.paymentReference);
    if (reference && paymentReferenceApplies(form.paymentMethod)) {
      if (reference.length > PAYMENT_REFERENCE_MAX_LENGTH || !PAYMENT_REFERENCE_RE.test(reference)) {
        return {
          field: 'reference',
          message: `Payment reference: up to ${PAYMENT_REFERENCE_MAX_LENGTH} letters, digits, spaces or . _ / - characters.`
        };
      }
    }
    if (trimOrEmpty(form.notes).length > 500) return { field: 'notes', message: 'Notes can be at most 500 characters.' };
    return null;
  }

  // The exact Stage 3A.1 request body - built field by field so nothing else (price, simulator,
  // duration, status, environment, booking source, ...) can ever ride along. The payment
  // reference is sent only for UPI/CARD; CASH/COMPLIMENTARY always send null.
  function buildWalkInPayload(form) {
    const email = trimOrEmpty(form.email);
    const notes = trimOrEmpty(form.notes);
    const reference = paymentReferenceApplies(form.paymentMethod) ? trimOrEmpty(form.paymentReference) : '';
    return {
      productCode: String(form.productCode),
      bookingDate: String(form.bookingDate),
      startTime: String(form.startTime),
      customer: {
        name: trimOrEmpty(form.name),
        phone: trimOrEmpty(form.phone),
        email: email || null
      },
      paymentMethod: String(form.paymentMethod),
      paymentReference: reference || null,
      notes: notes || null
    };
  }

  // Maps an adminFetch() result for POST /admin/bookings/walk-in to what the modal should do.
  //   ok           -> show the success state
  //   unauthenticated / forbidden -> hand off to admin.js's exitToLogin()/exitToForbidden()
  //   conflict     -> 409: the slot was taken meanwhile; reload availability
  //   validation   -> 400/404: show the backend's message as-is
  //   error        -> anything else (500, network): generic retry message
  function classifyWalkInResult(result) {
    if (!result) return { action: 'error', message: 'Could not create the booking. Please try again.' };
    if (result.kind === 'ok') return { action: 'ok' };
    if (result.kind === 'unauthenticated' || result.kind === 'forbidden') return { action: result.kind };
    const serverMessage = result.data && typeof result.data.message === 'string' ? result.data.message : '';
    if (result.kind === 'error' && result.status === 409) {
      return {
        action: 'conflict',
        message: 'That time slot is no longer available - another booking took it. Availability has been refreshed; please choose another time.'
      };
    }
    if (result.kind === 'error' && (result.status === 400 || result.status === 404)) {
      return { action: 'validation', message: serverMessage || 'The booking details were not accepted. Please check and try again.' };
    }
    if (result.kind === 'network') {
      return { action: 'error', message: 'Network error - please check your connection and try again.' };
    }
    return { action: 'error', message: 'Could not create the booking right now. Please try again.' };
  }

  // Human-facing summary of the 201 response - "Booking #1042", never the UUID.
  function walkInSuccessSummary(booking) {
    const b = booking || {};
    const product = b.product || {};
    const payment = b.payment || {};
    const reference = typeof b.bookingNumber === 'number' && Number.isFinite(b.bookingNumber)
      ? `Booking #${b.bookingNumber}`
      : 'Booking';
    const listPrice = Number(b.priceInr);
    const amountPaid = Number(payment.amountInr);
    return {
      reference,
      status: b.status === 'confirmed' ? 'Confirmed' : String(b.status || ''),
      packageName: product.name || product.code || '—',
      simulatorType: simulatorTypeLabel(product.simulatorType),
      racers: product.racers,
      durationMinutes: product.durationMinutes,
      date: b.date || '',
      startTime: b.startTime || '',
      endTime: b.endTime || '',
      simulators: Array.isArray(b.simulators) && b.simulators.length ? b.simulators.join(', ') : '—',
      paymentMethod: paymentMethodLabel(payment.method),
      amountPaid: Number.isFinite(amountPaid) ? formatInr(amountPaid) : '—',
      // Worth showing only when it differs from what was collected (i.e. COMPLIMENTARY).
      listPrice: Number.isFinite(listPrice) && listPrice !== amountPaid ? formatInr(listPrice) : null,
      customerName: (b.customer && b.customer.name) || ''
    };
  }

  // Single-flight guard for the Create Booking click: a second call while the first request is
  // still in flight resolves to null without calling `fn` again.
  function createSubmitGuard() {
    let inFlight = false;
    return {
      get busy() { return inFlight; },
      async run(fn) {
        if (inFlight) return null;
        inFlight = true;
        try {
          return await fn();
        } finally {
          inFlight = false;
        }
      }
    };
  }

  const api = {
    PAYMENT_METHODS,
    WALK_IN_PATH,
    escapeText,
    sessionProducts,
    productOptionLabel,
    simulatorTypeLabel,
    racersLabel,
    formatInr,
    availabilityPath,
    paymentReferenceApplies,
    paymentMethodLabel,
    previewAmountInr,
    isPastDate,
    filterUpcomingSlots,
    validateWalkInForm,
    buildWalkInPayload,
    classifyWalkInResult,
    walkInSuccessSummary,
    createSubmitGuard
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlayXAdminWalkIn = api;
})(typeof window !== 'undefined' ? window : globalThis);
