import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSesClient, sendBookingConfirmationEmail, sendOtpEmail } from './ses';
import type { BookingConfirmationDetails } from './booking-notifications';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { NOTIFICATION_ID_TAG } from './ses-tags';

let sent: any[] = [];

beforeEach(() => {
  sent = [];
  process.env.SES_REGION = 'ap-south-1';
  process.env.SES_FROM_EMAIL = 'bookings@playxcafe.com';
  process.env.SES_FROM_NAME = 'Play X Cafe';
  process.env.SES_REPLY_TO_EMAIL = 'bookings@playxcafe.com';
  (getSesClient() as any).send = async (cmd: any) => {
    sent.push(cmd.input);
    return {};
  };
});

test('sends from Play X Cafe <bookings@playxcafe.com> with Reply-To and OTP content', async () => {
  await sendOtpEmail('a@b.com', '123456');
  const input = sent[0];
  assert.equal(input.Source, 'Play X Cafe <bookings@playxcafe.com>');
  assert.deepEqual(input.ReplyToAddresses, ['bookings@playxcafe.com']);
  assert.deepEqual(input.Destination.ToAddresses, ['a@b.com']);
  assert.equal(input.Message.Subject.Data, 'Your Play X verification code');
  const body: string = input.Message.Body.Text.Data;
  for (const part of ['Play X Cafe', '123456', 'limited time', 'did not request', 'Race. Xperience. Hangout.']) {
    assert.ok(body.includes(part), `body missing: ${part}`);
  }
});

test('omits ReplyToAddresses when not configured', async () => {
  delete process.env.SES_REPLY_TO_EMAIL;
  await sendOtpEmail('a@b.com', '123456');
  assert.equal(sent[0].ReplyToAddresses, undefined);
});

test('throws when the sender is not configured', async () => {
  delete process.env.SES_FROM_EMAIL;
  await assert.rejects(sendOtpEmail('a@b.com', '123456'), /SES_FROM_EMAIL/);
});

// Stage 2F: the booking-confirmation email goes through the same client, sender and Reply-To.
test('booking confirmation: same verified sender + Reply-To, subject, text AND html parts; returns the MessageId', async () => {
  (getSesClient() as any).send = async (cmd: any) => {
    sent.push(cmd.input);
    return { MessageId: 'msg-123' };
  };
  const messageId = await sendBookingConfirmationEmail('racer@example.com', {
    bookingNumber: 1040,
    productName: 'Solo Pro',
    simulatorType: 'static',
    racers: 1,
    durationMinutes: 30,
    scheduledStartAt: new Date('2026-09-25T09:30:00Z'),
    scheduledEndAt: new Date('2026-09-25T10:00:00Z'),
    amountPaidInr: '399.00',
  });
  assert.equal(messageId, 'msg-123');
  const input = sent[0];
  assert.equal(input.Source, 'Play X Cafe <bookings@playxcafe.com>');
  assert.deepEqual(input.ReplyToAddresses, ['bookings@playxcafe.com']);
  assert.deepEqual(input.Destination.ToAddresses, ['racer@example.com']);
  assert.equal(input.Message.Subject.Data, 'Play X Cafe — Booking #1040 Confirmed');
  assert.ok(input.Message.Body.Text.Data.includes('Status: CONFIRMED'));
  assert.ok(input.Message.Body.Html.Data.includes('Booking confirmed'));
});

test('booking confirmation: throws when the sender is not configured', async () => {
  delete process.env.SES_FROM_EMAIL;
  await assert.rejects(
    sendBookingConfirmationEmail('a@b.com', {
      bookingNumber: 1, productName: 'x', simulatorType: null, racers: 1, durationMinutes: 30,
      scheduledStartAt: new Date(), scheduledEndAt: new Date(), amountPaidInr: '1.00',
    }),
    /SES_FROM_EMAIL/,
  );
});

// Stage 2G: delivery tracking — configuration set + one safe tag, booking confirmation only.
const DETAILS: BookingConfirmationDetails = {
  bookingNumber: 1040,
  productName: 'Solo Pro',
  simulatorType: 'static',
  racers: 1,
  durationMinutes: 30,
  scheduledStartAt: new Date('2026-09-25T09:30:00Z'),
  scheduledEndAt: new Date('2026-09-25T10:00:00Z'),
  amountPaidInr: '399.00',
};
const NOTIFICATION_ID = '6f1c1d0e-3a52-4c5e-9a0b-1f2e3d4c5b6a';

test('booking confirmation with tracking: uses the configuration set, attaches ONLY playx_notification_id, returns the MessageId', async () => {
  (getSesClient() as any).send = async (cmd: any) => {
    sent.push(cmd.input);
    return { MessageId: 'ses-msg-tracked' };
  };
  const messageId = await sendBookingConfirmationEmail('racer@example.com', DETAILS, {
    configurationSetName: 'playx-booking-emails',
    notificationId: NOTIFICATION_ID,
  });
  assert.equal(messageId, 'ses-msg-tracked');
  const input = sent[0];
  assert.equal(input.ConfigurationSetName, 'playx-booking-emails');
  assert.deepEqual(input.Tags, [{ Name: 'playx_notification_id', Value: NOTIFICATION_ID }]);
  // Everything else about the email is unchanged.
  assert.equal(input.Source, 'Play X Cafe <bookings@playxcafe.com>');
  assert.deepEqual(input.Destination.ToAddresses, ['racer@example.com']);
});

test('booking confirmation tags never carry customer PII', async () => {
  await sendBookingConfirmationEmail('racer@example.com', DETAILS, { configurationSetName: 'playx-booking-emails', notificationId: NOTIFICATION_ID });
  const tags = JSON.stringify(sent[0].Tags);
  for (const pii of ['racer@example.com', '@', 'Solo Pro', '1040', '399', '+91', 'sub']) {
    assert.ok(!tags.includes(pii), `tag leaks ${pii}`);
  }
  assert.equal(sent[0].Tags.length, 1);
});

test('booking confirmation without tracking: no configuration set, no tags (Stage 2F behaviour)', async () => {
  await sendBookingConfirmationEmail('racer@example.com', DETAILS);
  assert.equal(sent[0].ConfigurationSetName, undefined);
  assert.equal(sent[0].Tags, undefined);
});

test('booking confirmation tracking fails closed on a bad configuration set / tag value — nothing sent', async () => {
  await assert.rejects(sendBookingConfirmationEmail('a@b.com', DETAILS, { configurationSetName: '', notificationId: NOTIFICATION_ID }), /misconfigured/);
  await assert.rejects(sendBookingConfirmationEmail('a@b.com', DETAILS, { configurationSetName: 'playx-booking-emails', notificationId: 'racer@example.com' }), /misconfigured/);
  assert.equal(sent.length, 0);
});

test('OTP email is unchanged by Stage 2G: no configuration set, no tags', async () => {
  await sendOtpEmail('a@b.com', '123456');
  assert.equal(sent[0].ConfigurationSetName, undefined);
  assert.equal(sent[0].Tags, undefined);
});

test('tag contract: playx_notification_id, from a dependency-free module the OTP sender path can import', () => {
  // lib/ses.ts is bundled into the OTP CreateAuthChallenge Lambda: it must not import the Stage 2G
  // event consumer (whose top-level initializers esbuild cannot tree-shake), and ses-tags.ts must stay
  // a bare constant with no imports.
  assert.equal(NOTIFICATION_ID_TAG, 'playx_notification_id');
  const ses = readFileSync(path.join(__dirname, 'ses.ts'), 'utf8');
  assert.ok(!/from '\.\/booking-email-events'/.test(ses), 'ses.ts must not import booking-email-events');
  const tags = readFileSync(path.join(__dirname, 'ses-tags.ts'), 'utf8');
  assert.ok(!/^\s*import\b/m.test(tags), 'ses-tags.ts must not import anything');
});
