// Run with: node --test tests/
// Covers js/admin-payment-flags.js - the refund-required / manual-review flag on the Admin payment views.
const test = require('node:test');
const assert = require('node:assert/strict');
const { refundFlagHtml } = require('../js/admin-payment-flags.js');

test('ordinary payments get no flag', () => {
  assert.equal(refundFlagHtml({ refundRequired: false, reviewReason: null }), '');
  assert.equal(refundFlagHtml({}), '');
  assert.equal(refundFlagHtml(null), '');
});

test('refund-required payment shows REFUND REQUIRED, Manual review and the human reason', () => {
  const html = refundFlagHtml({ refundRequired: true, reviewReason: 'Duplicate payment (booking already paid)' });
  assert.match(html, /Refund required/);
  assert.match(html, /Manual review/);
  assert.match(html, /Duplicate payment \(booking already paid\)/);
  const late = refundFlagHtml({ refundRequired: true, reviewReason: 'Paid after reservation expired / capacity unavailable' });
  assert.match(late, /Paid after reservation expired/);
});

test('reason text is escaped and only typed fields are read (raw metadata is never rendered)', () => {
  const html = refundFlagHtml({ refundRequired: true, reviewReason: '<img src=x onerror=alert(1)>', metadata: { token: 'SECRET' } });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /SECRET/);
});

test('SANDBOX payments get a SANDBOX badge, alone or together with the refund-required flag', () => {
  assert.match(refundFlagHtml({ paymentEnvironment: 'SANDBOX', refundRequired: false }), /admin-sandbox-flag">Sandbox</);
  const both = refundFlagHtml({ paymentEnvironment: 'SANDBOX', refundRequired: true, reviewReason: 'Duplicate payment (booking already paid)' });
  assert.match(both, /Sandbox/);
  assert.match(both, /Refund required/);
  assert.match(both, /Manual review/);
  assert.equal(refundFlagHtml({ paymentEnvironment: 'PRODUCTION', refundRequired: false }), '');
  assert.doesNotMatch(refundFlagHtml({ paymentEnvironment: 'PRODUCTION', refundRequired: true }), /Sandbox/);
});
