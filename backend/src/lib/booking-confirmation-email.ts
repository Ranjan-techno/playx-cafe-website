// Stage 2F: the booking-confirmation email's content (subject, plain text, minimal HTML).
//
// Pure function of server-side booking data (see booking-notifications.ts's
// BookingConfirmationDetails) — nothing here comes from a request, a webhook or the browser.
// Customer-facing date/time are IST. Deliberately contains NO Cognito sub, database UUID, provider
// order/transaction id, payment-instrument detail, token or credential: the only identifier shown is
// the 4-digit booking number the customer already sees on the site.

import type { BookingConfirmationDetails } from './booking-notifications';
import { inrToPaise } from './money';

export interface ConfirmationEmailContent {
  subject: string;
  text: string;
  html: string;
}

const IST = 'Asia/Kolkata';

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((p) => p.type === type)?.value ?? '';
}

/** "Friday, 25 September 2026" in IST. Built from parts so the output never depends on the
 *  runtime's locale-specific punctuation. */
export function formatIstDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: IST, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(date);
  return `${part(parts, 'weekday')}, ${part(parts, 'day')} ${part(parts, 'month')} ${part(parts, 'year')}`;
}

/** "3:00 PM" in IST. */
export function formatIstTime(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: IST, hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(date);
  return `${part(parts, 'hour')}:${part(parts, 'minute')} ${part(parts, 'dayPeriod').toUpperCase()}`;
}

/** "₹399" / "₹1,099" / "₹399.50" — Indian digit grouping, paise only when non-zero. */
export function formatInr(amountInr: string): string {
  const paise = inrToPaise(amountInr);
  const rupees = Math.floor(paise / 100);
  const fraction = paise % 100;
  const grouped = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(rupees);
  return `₹${grouped}${fraction === 0 ? '' : `.${String(fraction).padStart(2, '0')}`}`;
}

function simulatorLabel(type: BookingConfirmationDetails['simulatorType']): string | null {
  if (type === 'static') return 'Static';
  if (type === 'motion') return 'Motion';
  return null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildBookingConfirmationEmail(details: BookingConfirmationDetails): ConfirmationEmailContent {
  const subject = `Play X Cafe — Booking #${details.bookingNumber} Confirmed`;
  const simulator = simulatorLabel(details.simulatorType);

  const rows: [string, string][] = [
    ['Booking number', `#${details.bookingNumber}`],
    ['Xperience', details.productName],
    ...(simulator ? [['Simulator', simulator] as [string, string]] : []),
    ['Date', formatIstDate(details.scheduledStartAt)],
    ['Time', `${formatIstTime(details.scheduledStartAt)} – ${formatIstTime(details.scheduledEndAt)} IST`],
    ['Duration', `${details.durationMinutes} minutes`],
    ['Amount paid', formatInr(details.amountPaidInr)],
    ['Status', 'CONFIRMED'],
  ];

  const text =
    'Play X Cafe\n\n' +
    'Booking confirmed\n\n' +
    'Your payment was received and your booking is confirmed.\n\n' +
    rows.map(([label, value]) => `${label}: ${value}`).join('\n') +
    '\n\nPlease arrive a few minutes before your start time.\n\n' +
    'Race. Play. Chill.\n' +
    'Play X Cafe';

  const htmlRows = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#8a8f98;white-space:nowrap;">${escapeHtml(label)}</td>` +
        `<td style="padding:6px 0;color:#111111;font-weight:600;">${escapeHtml(value)}</td></tr>`,
    )
    .join('');

  const html =
    '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f5;">' +
    '<div style="max-width:520px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="background:#0c0c0d;color:#f5f3f0;padding:18px 24px;border-radius:8px 8px 0 0;border-bottom:3px solid #e2231a;font-size:20px;font-weight:700;letter-spacing:0.5px;">Play X Cafe</div>' +
    '<div style="background:#ffffff;padding:24px;border-radius:0 0 8px 8px;">' +
    '<h1 style="margin:0 0 8px;font-size:22px;color:#111111;">Booking confirmed</h1>' +
    '<p style="margin:0 0 16px;color:#444444;font-size:14px;">Your payment was received and your booking is confirmed.</p>' +
    `<table role="presentation" style="border-collapse:collapse;font-size:14px;">${htmlRows}</table>` +
    '<p style="margin:20px 0 0;color:#444444;font-size:14px;">Please arrive a few minutes before your start time.</p>' +
    '<p style="margin:20px 0 0;color:#e2231a;font-size:14px;font-weight:700;">Race. Play. Chill.</p>' +
    '</div></div></body></html>';

  return { subject, text, html };
}
