// PhonePe cutover Stage 2C: server-side tester allowlist for the PRODUCTION booking and payment-start
// runtimes, so ONE real production transaction can be made for PhonePe's verification before
// production is opened to everyone.
//
// This is a second gate BEHIND each Lambda's kill switch (BOOKING_CREATE_ENABLED /
// PAYMENT_START_ENABLED), never instead of it: a disabled switch still answers 503 before this runs.
// Once a later deploy turns a switch on, the caller's verified Cognito `sub` must also be listed in
// PHONEPE_PRODUCTION_TESTERS (a comma-separated Lambda environment variable set at deploy time from
// the `phonepeProductionTesters` CDK context — see infra/lib/config/payment-config.ts).
//
// Subjects only: unlike the SANDBOX list (sandbox-access.ts) no email is ever accepted — the only
// identity trusted here is the `sub` claim API Gateway's JWT authorizer verified. Matching is exact
// (after trimming list entries); nothing from the request body is read. Fails CLOSED: a missing or
// empty list denies everyone.

export class ProductionTesterNotAllowedError extends Error {
  readonly code = 'production_tester_not_allowed';
  constructor() {
    super('This account is not permitted to use the production payment runtime');
  }
}

export function parseProductionTesters(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

/** True only when `sub` is a non-empty verified subject listed in `rawTesters`. */
export function isProductionTester(sub: string, rawTesters: string | undefined): boolean {
  return sub.length > 0 && parseProductionTesters(rawTesters).has(sub);
}

/** Throws ProductionTesterNotAllowedError unless `sub` is on the production tester allowlist. */
export function assertProductionTesterAllowed(sub: string, rawTesters: string | undefined): void {
  if (!isProductionTester(sub, rawTesters)) {
    throw new ProductionTesterNotAllowedError();
  }
}
