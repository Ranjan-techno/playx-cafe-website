import { randomInt } from 'node:crypto';

// Guest-first passwordless auth: Play X's product decision is that every OTP a customer sees is
// exactly six numeric digits. Cognito's own native EMAIL_OTP first factor generates eight-digit
// codes — not configurable — which is the whole reason auth-create-challenge.ts/
// auth-verify-challenge.ts/auth-define-challenge.ts exist as a Cognito CUSTOM_AUTH challenge
// instead of using EMAIL_OTP directly. `OTP_CODE_RE` is the single source of truth for "exactly
// six digits" on both sides: `generateOtp()` (auth-create-challenge.ts) always produces a string
// matching it, and auth-verify.ts validates a submitted code against it before Cognito ever sees
// it.
//
// crypto.randomInt is a CSPRNG (unlike Math.random, which is not safe for anything
// security-sensitive) — see https://nodejs.org/api/crypto.html#cryptorandomintmin-max-callback.

export const OTP_CODE_RE = /^\d{6}$/;

const OTP_MIN = 100_000;
const OTP_MAX = 1_000_000; // exclusive upper bound — randomInt's range is [min, max)

export function generateOtp(): string {
  return randomInt(OTP_MIN, OTP_MAX).toString();
}
