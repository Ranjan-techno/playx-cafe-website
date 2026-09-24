// SANDBOX/PRODUCTION environment of bookings.booking_environment and payments.payment_environment
// (database/migrations/006_payment_environment_expansion.sql) — the typed source of truth.
// payments.metadata.paymentEnvironment is only a backward-compatibility/display mirror.
//
// Every value written to these columns comes from the backend: a server-side literal for bookings
// (create-booking.ts) and the validated PhonePe config for payments (payment-start.ts). Nothing
// here ever reads a request body, Origin or hostname.
//
// Both columns are NOT NULL with no DEFAULT (database/migrations/007_enforce_payment_environment.sql),
// so every row carries an explicit environment. Matching is strict: SANDBOX matches only SANDBOX,
// PRODUCTION only PRODUCTION, and NULL or any unknown value matches nothing (fails closed) — it is
// never treated as SANDBOX.

export type AppEnvironment = 'SANDBOX' | 'PRODUCTION';

export const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['SANDBOX', 'PRODUCTION'];

export function isAppEnvironment(value: unknown): value is AppEnvironment {
  return value === 'SANDBOX' || value === 'PRODUCTION';
}

/** Fails closed on anything but the two known values — used on every write path, so a missing or
 *  mistyped environment can never silently produce a row. */
export function assertAppEnvironment(value: unknown, what: string): AppEnvironment {
  if (!isAppEnvironment(value)) {
    throw new Error(`${what} must be SANDBOX or PRODUCTION`);
  }
  return value;
}

/** What a stored column value means for business logic: the two known values as-is; NULL,
 *  undefined or anything unexpected -> null (matches no environment, counts as nothing). */
export function effectiveStoredEnvironment(value: string | null | undefined): AppEnvironment | null {
  return isAppEnvironment(value) ? value : null;
}

/** True only when a stored row is exactly `expected`. NULL/unknown never matches. */
export function storedEnvironmentMatches(value: string | null | undefined, expected: AppEnvironment): boolean {
  return effectiveStoredEnvironment(value) === expected;
}

/** SQL predicate: `column` belongs to the environment bound at `param` (e.g. '$1'). The caller
 *  binds `environment` itself at that position. Always `column = $n` — NULL never matches. */
export function environmentMatchSql(column: string, param: string, environment: AppEnvironment): string {
  assertAppEnvironment(environment, 'environment');
  return `${column} = ${param}`;
}

/** SQL expression for a column's effective environment (reporting/accounting): the typed column
 *  itself, with no fallback. */
export function effectiveEnvironmentSql(column: string): string {
  return column;
}
