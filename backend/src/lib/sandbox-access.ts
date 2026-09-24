// Server-side gate for SANDBOX payments. The API and database are shared by staging and
// production, so a sandbox payment must never be startable just because the page was loaded from
// a staging hostname (a frontend check is not a security boundary). In SANDBOX mode, POST
// /payments/start must additionally pass this allowlist check; PRODUCTION mode skips it.
//
// The allowlist is a comma-separated set of Cognito subs and/or emails in PHONEPE_SANDBOX_TESTERS
// (Lambda environment) — never hard-coded. Fails CLOSED: SANDBOX with a missing/empty list denies
// everyone. An email only counts when the token says it is verified.

import type { PhonePeEnvironment } from './phonepe-config';

export class SandboxTestersNotConfiguredError extends Error {
  readonly code = 'sandbox_testers_not_configured';
  constructor() {
    super('Sandbox payments are enabled but PHONEPE_SANDBOX_TESTERS is not configured');
  }
}

export class SandboxTesterNotAllowedError extends Error {
  readonly code = 'sandbox_tester_not_allowed';
  constructor() {
    super('This account is not permitted to make sandbox payments');
  }
}

export interface PaymentUserIdentity {
  sub: string;
  email?: string;
  emailVerified?: boolean;
}

export function parseSandboxTesters(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/** Throws unless payment start is allowed for `user` under `environment`. */
export function assertPaymentStartAllowed(
  environment: PhonePeEnvironment,
  user: PaymentUserIdentity,
  rawTesters: string | undefined = process.env.PHONEPE_SANDBOX_TESTERS,
): void {
  if (environment !== 'SANDBOX') {
    return;
  }
  const testers = parseSandboxTesters(rawTesters);
  if (testers.size === 0) {
    throw new SandboxTestersNotConfiguredError();
  }
  const subMatch = user.sub.length > 0 && testers.has(user.sub.toLowerCase());
  const emailMatch = user.emailVerified === true && !!user.email && testers.has(user.email.trim().toLowerCase());
  if (!subMatch && !emailMatch) {
    throw new SandboxTesterNotAllowedError();
  }
}
