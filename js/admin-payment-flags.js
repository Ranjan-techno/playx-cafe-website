// DOM-free helper for js/admin.js: the "REFUND REQUIRED / Manual review" flag shown on the Admin
// Payments list and on a booking's payment history. It reads ONLY the typed fields the admin API
// exposes (refundRequired, reviewReason) — never payments.metadata, which is not in the response.
// reviewReason is already whitelisted human wording from the backend; it is HTML-escaped here too.
(function (root) {
  function escapeText(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // '' for an ordinary production payment, so callers can append it unconditionally.
  function refundFlagHtml(payment) {
    if (!payment) return '';
    const sandbox = payment.paymentEnvironment === 'SANDBOX' ? '<span class="admin-sandbox-flag">Sandbox</span> ' : '';
    if (payment.refundRequired !== true) return sandbox.trim();
    const reason = payment.reviewReason
      ? `<span class="admin-cell-sub">${escapeText(payment.reviewReason)}</span>`
      : '';
    return `${sandbox}<span class="admin-refund-flag">Refund required</span> <span class="admin-manual-review">Manual review</span>${reason}`;
  }

  const api = { refundFlagHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PlayXAdminPaymentFlags = api;
})(typeof window !== 'undefined' ? window : globalThis);
