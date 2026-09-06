// A TypeScript port of js/cognito-auth.js's normalizeIndianMobileToE164 — kept as a separate
// port rather than a shared module since the frontend has no build step/module system to import
// from here. Accepts a bare 10-digit number, a leading-0 11-digit number, or a 91-prefixed
// 12-digit number, and normalizes all three to +91XXXXXXXXXX; anything else is rejected.

export function normalizeIndianPhone(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const digits = raw.replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) {
    return `+91${digits}`;
  }
  if (/^0\d{10}$/.test(digits)) {
    return `+91${digits.slice(1)}`;
  }
  if (/^91\d{10}$/.test(digits)) {
    return `+${digits}`;
  }
  return null;
}
