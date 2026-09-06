// Shared by auth-start.ts and auth-verify.ts so the email format check/normalization isn't
// duplicated across both handlers. Deliberately simple, matching this project's "hand-roll a
// narrow regex" convention (see create-booking.ts's PRODUCT_CODE_RE/DATE_RE/TIME_RE) rather than
// pulling in a validation library.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254; // RFC 5321 max mailbox length

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > EMAIL_MAX_LENGTH) {
    return null;
  }
  return EMAIL_RE.test(email) ? email : null;
}
