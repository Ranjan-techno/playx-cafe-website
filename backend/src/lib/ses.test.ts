import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSesClient, sendBookingConfirmationEmail, sendOtpEmail } from './ses';

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
