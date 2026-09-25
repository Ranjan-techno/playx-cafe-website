import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBookingConfirmationEmail, formatInr, formatIstDate, formatIstTime } from './booking-confirmation-email';
import type { BookingConfirmationDetails } from './booking-notifications';

// Stage 2F: the confirmation email's content — IST date/time, amount formatting, escaping, and the
// guarantee that nothing internal (UUIDs, Cognito sub, provider ids) can appear in it.

const details: BookingConfirmationDetails = {
  bookingNumber: 1033,
  productName: 'Solo Racing Xperience — Pro',
  simulatorType: 'motion',
  racers: 1,
  durationMinutes: 30,
  // 09:30Z = 3:00 PM IST on Friday 25 September 2026 (Grand Opening).
  scheduledStartAt: new Date('2026-09-25T09:30:00Z'),
  scheduledEndAt: new Date('2026-09-25T10:00:00Z'),
  amountPaidInr: '399.00',
};

test('subject: "Play X Cafe — Booking #<bookingNumber> Confirmed"', () => {
  assert.equal(buildBookingConfirmationEmail(details).subject, 'Play X Cafe — Booking #1033 Confirmed');
});

test('text body carries every customer-facing field, in IST, and the closing line', () => {
  const { text } = buildBookingConfirmationEmail(details);
  for (const part of [
    'Play X Cafe',
    'Booking confirmed',
    'Booking number: #1033',
    'Xperience: Solo Racing Xperience — Pro',
    'Simulator: Motion',
    'Date: Friday, 25 September 2026',
    'Time: 3:00 PM – 3:30 PM IST',
    'Amount paid: ₹399',
    'Status: CONFIRMED',
    'Race Xperience Hangout',
  ]) {
    assert.ok(text.includes(part), `text missing: ${part}`);
  }
});

test('IST conversion crosses the UTC date line correctly', () => {
  // 20:00Z on the 24th is 01:30 on the 25th in IST.
  const late = new Date('2026-09-24T20:00:00Z');
  assert.equal(formatIstDate(late), 'Friday, 25 September 2026');
  assert.equal(formatIstTime(late), '1:30 AM');
  assert.equal(formatIstTime(new Date('2026-09-25T17:30:00Z')), '11:00 PM');
});

test('amounts: Indian grouping, paise only when non-zero', () => {
  assert.equal(formatInr('399.00'), '₹399');
  assert.equal(formatInr('1099.00'), '₹1,099');
  assert.equal(formatInr('125000.00'), '₹1,25,000');
  assert.equal(formatInr('399.50'), '₹399.50');
});

test('HTML part: same facts, product name escaped', () => {
  const { html } = buildBookingConfirmationEmail({ ...details, productName: '<b>Race & "Chill"</b>' });
  assert.ok(html.includes('&lt;b&gt;Race &amp; &quot;Chill&quot;&lt;/b&gt;'));
  assert.ok(!html.includes('<b>Race'));
  for (const part of ['Booking confirmed', '#1033', 'CONFIRMED', '₹399', 'Race Xperience Hangout', '3:00 PM – 3:30 PM IST']) {
    assert.ok(html.includes(part), `html missing: ${part}`);
  }
});

test('simulator line omitted when the product has no simulator type', () => {
  const { text } = buildBookingConfirmationEmail({ ...details, simulatorType: null });
  assert.ok(!text.includes('Simulator:'));
});

test('no internal identifiers can appear: the only inputs are display fields, and no UUID-shaped text is produced', () => {
  const { subject, text, html } = buildBookingConfirmationEmail(details);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  for (const body of [subject, text, html]) {
    assert.doesNotMatch(body, uuid);
    assert.doesNotMatch(body, /sub|order id|transaction|upi|card|token|secret/i);
  }
});

test('footer tagline is "Race Xperience Hangout" in both bodies; the old tagline is gone', () => {
  const { html, text } = buildBookingConfirmationEmail(details);
  assert.ok(html.includes('>Race Xperience Hangout</p>'));
  assert.ok(text.includes('Race Xperience Hangout\n'));
  for (const body of [html, text]) assert.ok(!body.includes('Race. Play. Chill.'));
});
