// SANDBOX/PRODUCTION environment of bookings.booking_environment and payments.payment_environment
// (database/migrations/006_payment_environment_expansion.sql) — the typed source of truth.
// payments.metadata.paymentEnvironment is only a backward-compatibility/display mirror.
//
// Every value written to these columns comes from the backend: a server-side literal for bookings
// (create-booking.ts) and the validated PhonePe config for payments (payment-start.ts). Nothing
// here ever reads a request body, Origin or hostname.
//
// TRANSITIONAL (Stage 1B, between migration 006 and the ENFORCE migration): both columns are still
// nullable, and a row written by the old code after 006 but before this code was deployed has
// NULL. PhonePe PRODUCTION has never been enabled, so such a NULL can only be legacy SANDBOX — and
// ONLY ever matches SANDBOX, never PRODUCTION. Everything NULL-aware lives in this file, behind
// TRANSITIONAL_NULL_IS_SANDBOX; once ENFORCE has backfilled the NULLs and set NOT NULL, set that
// flag to false (or delete the NULL branches) and nothing else needs to change.

export type AppEnvironment = 'SANDBOX' | 'PRODUCTION';

export const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['SANDBOX', 'PRODUCTION'];

/** Remove (or set false) after the ENFORCE migration makes both columns NOT NULL. */
export const TRANSITIONAL_NULL_IS_SANDBOX = true;

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

/** What a stored column value means for business logic. NULL -> SANDBOX only during the
 *  transition; any unexpected value -> null (matches no environment, counts as nothing). */
export function effectiveStoredEnvironment(value: string | null | undefined): AppEnvironment | null {
  if (isAppEnvironment(value)) {
    return value;
  }
  if ((value === null || value === undefined) && TRANSITIONAL_NULL_IS_SANDBOX) {
    return 'SANDBOX';
  }
  return null;
}

/** True when a stored row belongs to `expected`. A transitional NULL matches SANDBOX only. */
export function storedEnvironmentMatches(value: string | null | undefined, expected: AppEnvironment): boolean {
  return effectiveStoredEnvironment(value) === expected;
}

/** SQL predicate: `column` belongs to the environment bound at `param` (e.g. '$1'). The caller
 *  binds `environment` itself at that position.
 *    SANDBOX    -> (column = $n OR column IS NULL)   [transitional NULL]
 *    PRODUCTION -> column = $n                      [NULL never matches] */
export function environmentMatchSql(column: string, param: string, environment: AppEnvironment): string {
  assertAppEnvironment(environment, 'environment');
  if (environment === 'SANDBOX' && TRANSITIONAL_NULL_IS_SANDBOX) {
    return `(${column} = ${param} OR ${column} IS NULL)`;
  }
  return `${column} = ${param}`;
}

/** SQL expression for a column's effective environment (reporting/accounting). */
export function effectiveEnvironmentSql(column: string): string {
  return TRANSITIONAL_NULL_IS_SANDBOX ? `COALESCE(${column}, 'SANDBOX')` : column;
}
