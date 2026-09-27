// Run with: node --test tests/
// Covers js/admin-email-status.js - the Booking Detail "EMAIL" section (Stage 2G delivery tracking).
const test = require('node:test');
const assert = require('node:assert/strict');
const { emailNotificationHtml, confirmationLabel, deliveryLabel } = require('../js/admin-email-status.js');

const SENT_AT = '2026-09-25T06:00:00.000Z';
const fmt = (iso) => `IST(${iso})`;

function cell(html, label) {
  const m = new RegExp(`<span>${label}</span><strong>(.*?)</strong>`).exec(html);
  return m ? m[1].replace(/<[^>]+>/g, '') : null;
}

test('tracked + delivered: Confirmation SENT, Delivery DELIVERED, with sent/delivered times', () => {
  const html = emailNotificationHtml({ status: 'sent', deliveryStatus: 'delivered', sentAt: SENT_AT, deliveredAt: '2026-09-25T06:00:04.000Z' }, fmt);
  assert.equal(cell(html, 'Confirmation'), 'SENT');
  assert.equal(cell(html, 'Delivery'), 'DELIVERED');
  assert.equal(cell(html, 'Sent'), `IST(${SENT_AT})`);
  assert.equal(cell(html, 'Delivered'), 'IST(2026-09-25T06:00:04.000Z)');
  assert.match(html, /admin-email-pill good">DELIVERED/);
  assert.equal(cell(html, 'Reason'), null);
});

test('bounced: Delivery BOUNCED in the bad tone, with the sanitized reason', () => {
  const html = emailNotificationHtml({ status: 'sent', deliveryStatus: 'bounced', sentAt: SENT_AT, bouncedAt: '2026-09-25T06:01:00.000Z', deliveryFailureType: 'Permanent', deliveryFailureSubtype: 'General' }, fmt);
  assert.equal(cell(html, 'Confirmation'), 'SENT');
  assert.equal(cell(html, 'Delivery'), 'BOUNCED');
  assert.match(html, /admin-email-pill bad">BOUNCED/);
  assert.equal(cell(html, 'Reason'), 'Permanent / General');
  assert.equal(cell(html, 'Bounced'), 'IST(2026-09-25T06:01:00.000Z)');
});

test('untracked (sent before Stage 2G): Delivery NOT TRACKED — never FAILED', () => {
  const html = emailNotificationHtml({ status: 'sent', deliveryStatus: null, sentAt: SENT_AT }, fmt);
  assert.equal(cell(html, 'Confirmation'), 'SENT');
  assert.equal(cell(html, 'Delivery'), 'NOT TRACKED');
  assert.doesNotMatch(html, /FAILED/);
  assert.doesNotMatch(html, /pill bad/);
});

test('tracked but not yet final: ACCEPTED / DELAYED in the waiting tone', () => {
  assert.match(emailNotificationHtml({ status: 'sent', deliveryStatus: 'accepted', sentAt: SENT_AT }), /admin-email-pill wait">ACCEPTED/);
  const delayed = emailNotificationHtml({ status: 'sent', deliveryStatus: 'delayed', sentAt: SENT_AT, deliveryFailureType: 'DeliveryDelay', deliveryFailureSubtype: 'MailboxFull' });
  assert.match(delayed, /admin-email-pill wait">DELAYED/);
  assert.equal(cell(delayed, 'Reason'), 'DeliveryDelay / MailboxFull');
});

test('every delivery state has a label; complained/rejected/rendering_failed are bad', () => {
  const expected = { accepted: 'ACCEPTED', delayed: 'DELAYED', delivered: 'DELIVERED', bounced: 'BOUNCED', complained: 'COMPLAINED', rejected: 'REJECTED', rendering_failed: 'RENDERING FAILED' };
  for (const [state, label] of Object.entries(expected)) {
    assert.equal(deliveryLabel({ status: 'sent', deliveryStatus: state }), label);
  }
  for (const state of ['complained', 'rejected', 'rendering_failed']) {
    assert.match(emailNotificationHtml({ status: 'sent', deliveryStatus: state }), /admin-email-pill bad/);
  }
});

test('no notification / not sent: confirmation NONE/PENDING/FAILED/SUPPRESSED and delivery —', () => {
  assert.equal(confirmationLabel(null), 'NONE');
  assert.equal(deliveryLabel(null), '—');
  const none = emailNotificationHtml(null);
  assert.equal(cell(none, 'Confirmation'), 'NONE');
  assert.equal(cell(none, 'Delivery'), '—');
  for (const [status, label] of [['pending', 'PENDING'], ['failed', 'FAILED'], ['suppressed', 'SUPPRESSED']]) {
    const html = emailNotificationHtml({ status, deliveryStatus: null, sentAt: null });
    assert.equal(cell(html, 'Confirmation'), label);
    assert.equal(cell(html, 'Delivery'), '—');
    assert.equal(cell(html, 'Sent'), null);
  }
});

test('only typed fields render, escaped; unknown fields (message id, recipient) never appear', () => {
  const html = emailNotificationHtml({
    status: 'sent', deliveryStatus: 'bounced', sentAt: SENT_AT,
    deliveryFailureType: '<img src=x onerror=alert(1)>',
    providerMessageId: 'ses-msg-SECRET', notificationId: 'uuid-SECRET', recipient: 'racer@example.com',
  });
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /SECRET|racer@example\.com/);
});

test('admin.html loads the helper before admin.js, and admin.js renders the Email section', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(path.join(__dirname, '../admin.html'), 'utf8');
  const helper = html.indexOf('<script src="js/admin-email-status.js"></script>');
  assert.ok(helper > 0 && helper < html.indexOf('<script src="js/admin.js"></script>'));
  const adminJs = fs.readFileSync(path.join(__dirname, '../js/admin.js'), 'utf8');
  assert.match(adminJs, /<h3>Email<\/h3>/);
  assert.match(adminJs, /PlayXAdminEmailStatus\.emailNotificationHtml\(detail\.emailNotification, formatDateTimeDisplay\)/);
});
