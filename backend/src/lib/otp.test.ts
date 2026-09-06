import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OTP_CODE_RE, generateOtp } from './otp';

// Guest-first passwordless auth: the product decision this whole CUSTOM_AUTH flow exists for is
// "every OTP is exactly six numeric digits" — these are the two places that contract could break.

test('OTP_CODE_RE accepts exactly six digits', () => {
  assert.equal(OTP_CODE_RE.test('482308'), true);
  assert.equal(OTP_CODE_RE.test('000000'), true);
});

test('OTP_CODE_RE rejects five digits', () => {
  assert.equal(OTP_CODE_RE.test('48230'), false);
});

test('OTP_CODE_RE rejects seven digits', () => {
  assert.equal(OTP_CODE_RE.test('4823088'), false);
});

test('OTP_CODE_RE rejects eight digits (Cognito native EMAIL_OTP shape)', () => {
  assert.equal(OTP_CODE_RE.test('48230812'), false);
});

test('OTP_CODE_RE rejects non-numeric input', () => {
  assert.equal(OTP_CODE_RE.test('48230a'), false);
  assert.equal(OTP_CODE_RE.test('ABCDEF'), false);
  assert.equal(OTP_CODE_RE.test('482 08'), false);
});

test('generateOtp() always returns exactly six numeric digits', () => {
  for (let i = 0; i < 1000; i++) {
    const code = generateOtp();
    assert.match(code, OTP_CODE_RE, `generateOtp() produced "${code}", not six digits`);
  }
});
