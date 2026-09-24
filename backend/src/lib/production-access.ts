// Server-side access gate for the PRODUCTION booking and payment-start runtimes (Stage 2E: an
// explicit production access mode replacing the Stage 2C-2D "tester cutover" concept).
//
// This is a second gate BEHIND each Lambda's kill switch (BOOKING_CREATE_ENABLED /
// PAYMENT_START_ENABLED), never instead of it: a disabled switch still answers 503 before this runs.
//
// PHONEPE_PRODUCTION_ACCESS_MODE (a Lambda environment variable set at deploy time from the
// `phonepeProductionAccessMode` CDK context — see infra/lib/config/payment-config.ts) picks one of:
//
//   TESTER  (the safe default) — the caller's verified Cognito `sub` must be listed in
//           PHONEPE_PRODUCTION_TESTERS (comma-separated, from the `phonepeProductionTesters`
//           context). A missing or empty list denies everyone (fail closed).
//   PUBLIC  — any authenticated customer (a non-empty verified `sub`). Everything else stays
//           mandatory and is enforced elsewhere: booking ownership, the server-side amount, the
//           hard-coded PRODUCTION environment.
//
// Only the exact string "PUBLIC" selects PUBLIC. Missing, blank, lowercase, padded or unknown values
// all resolve to TESTER, and an empty tester list never implies PUBLIC.
//
// Subjects only: unlike the SANDBOX list (sandbox-access.ts) no email is ever accepted — the only
// identity trusted here is the `sub` claim API Gateway's JWT authorizer verified. Matching is exact
// (after trimming list entries); nothing from the request body is read.

export type ProductionAccessMode = 'TESTER' | 'PUBLIC';

export class ProductionTesterNotAllowedError extends Error {
  readonly code = 'production_tester_not_allowed';
  constructor() {
    super('This account is not permitted to use the production payment runtime');
  }
}

/** PHONEPE_PRODUCTION_ACCESS_MODE -> mode. PUBLIC only on the exact string; everything else TESTER. */
export function resolveProductionAccessMode(raw: string | undefined): ProductionAccessMode {
  return raw === 'PUBLIC' ? 'PUBLIC' : 'TESTER';
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

/** Whether `sub` may use the PRODUCTION booking/payment-start runtime under the Lambda's configured
 *  access mode. Reads only PHONEPE_PRODUCTION_ACCESS_MODE and PHONEPE_PRODUCTION_TESTERS. */
export function isProductionAccessAllowed(sub: string, env: NodeJS.ProcessEnv): boolean {
  if (typeof sub !== 'string' || sub.length === 0) {
    return false;
  }
  if (resolveProductionAccessMode(env.PHONEPE_PRODUCTION_ACCESS_MODE) === 'PUBLIC') {
    return true;
  }
  return isProductionTester(sub, env.PHONEPE_PRODUCTION_TESTERS);
}

/** Throws ProductionTesterNotAllowedError unless `sub` may use the PRODUCTION runtime. */
export function assertProductionAccessAllowed(sub: string, env: NodeJS.ProcessEnv): void {
  if (!isProductionAccessAllowed(sub, env)) {
    throw new ProductionTesterNotAllowedError();
  }
}
