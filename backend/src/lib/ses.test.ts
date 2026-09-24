import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getSesClient, sendOtpEmail } from './ses';

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
