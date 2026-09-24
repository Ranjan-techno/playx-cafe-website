/**
 * Stage 2F: per-environment configuration of the transactional booking-confirmation email.
 *
 * Kept separate from the other per-concern config files. Nothing here is a credential: the email
 * goes through the SES identity already configured in auth-config.ts (sesFromEmail/sesRegion) —
 * no second sender, domain or provider.
 */
export interface NotificationConfig {
  /** Server-side sender kill switch, rendered as BOOKING_CONFIRMATION_EMAIL_ENABLED ('true'/'false')
   *  on the sender Lambda. Always set explicitly — the backend treats anything but "true" as off.
   *  Off = pending confirmations wait (and are suppressed if they go stale or the session passes). */
  confirmationEmailEnabled: boolean;
}

export const notificationConfigs: Record<'dev' | 'prod', NotificationConfig> = {
  dev: {
    // The deployed shared stack (production + staging). PRODUCTION bookings are emailed; SANDBOX
    // (staging) ones are suppressed unless their account email is on the sandbox allowlist below.
    confirmationEmailEnabled: true,
  },
  prod: {
    // Not read by any stack this phase (see bin/infra.ts).
    confirmationEmailEnabled: false,
  },
};

const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/**
 * Stage 2F: emails that SANDBOX (staging) booking confirmations may be sent to — for testing the
 * real email end to end without ever emailing arbitrary staging customers. Supplied only via
 * `cdk deploy -c bookingEmailSandboxAllowlist=qa@example.com[,...]` (never an ambient environment
 * variable). Absent/empty = nobody: every SANDBOX confirmation is suppressed. Entries are trimmed,
 * lower-cased and de-duplicated; anything that is not an email fails the synth.
 */
export function resolveBookingEmailSandboxAllowlist(contextValue: unknown): string {
  if (contextValue === undefined || contextValue === null) {
    return '';
  }
  if (typeof contextValue !== 'string') {
    throw new Error('bookingEmailSandboxAllowlist must be a comma-separated string of email addresses');
  }
  const entries = contextValue
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (!EMAIL_RE.test(entry)) {
      throw new Error(`bookingEmailSandboxAllowlist: "${entry}" is not an email address`);
    }
  }
  return [...new Set(entries)].join(',');
}
