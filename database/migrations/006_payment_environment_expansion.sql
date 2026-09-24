-- Payment environment columns — EXPAND step of an EXPAND -> CODE -> ENFORCE rollout.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001-005 — never automatically, never on deploy. Safe to run BEFORE the backend build that
-- writes these columns: it is additive only.
--
-- Why: bookings and payments need a first-class SANDBOX/PRODUCTION marker (today payments only
-- carry metadata.paymentEnvironment, see 005) so the PhonePe production cutover can keep sandbox
-- and production rows apart in queries, reconciliation and reporting.
--
-- Why EXPAND only: the currently deployed create-booking/payment-start Lambdas do not write these
-- columns. Setting them NOT NULL (or relying on a DEFAULT) now would either break those inserts or
-- silently stamp new rows with a guessed environment. So in this step the columns are:
--   * nullable (the old code keeps inserting NULL, which the CHECKs allow),
--   * without a DEFAULT (the application must always state the environment explicitly),
--   * backfilled for every existing row.
-- A later ENFORCE migration — only after the new application code is deployed and verified —
-- backfills any NULLs written during the transition to SANDBOX, sets both columns NOT NULL (still
-- no DEFAULT), and may drop the environment-blind idx_payments_open_for_reconciliation.
--
-- PhonePe PRODUCTION has never been enabled, so every historical booking belongs to the sandbox /
-- test-era backend, and every historical payment is SANDBOX unless its metadata explicitly says
-- PRODUCTION.
--
-- Idempotency: the runner applies each file at most once, in its own transaction. The statements
-- are additionally guarded (IF NOT EXISTS / WHERE ... IS NULL) so a re-run is a no-op. The CHECK
-- constraints are declared inline on ADD COLUMN IF NOT EXISTS, so they are only added together
-- with their column and never duplicated.

-- ---------------------------------------------------------------------------------------------
-- bookings.booking_environment
-- ---------------------------------------------------------------------------------------------

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_environment TEXT
    CONSTRAINT bookings_booking_environment_chk
    CHECK (booking_environment IN ('SANDBOX', 'PRODUCTION'));

UPDATE bookings
SET booking_environment = 'SANDBOX'
WHERE booking_environment IS NULL;

CREATE INDEX IF NOT EXISTS idx_bookings_booking_environment
  ON bookings (booking_environment);

-- ---------------------------------------------------------------------------------------------
-- payments.payment_environment
-- ---------------------------------------------------------------------------------------------

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS payment_environment TEXT
    CONSTRAINT payments_payment_environment_chk
    CHECK (payment_environment IN ('SANDBOX', 'PRODUCTION'));

-- Only an explicit PRODUCTION marker stays PRODUCTION; SANDBOX, a missing marker, NULL metadata
-- and any unexpected value are SANDBOX.
UPDATE payments
SET payment_environment = CASE
    WHEN metadata ->> 'paymentEnvironment' = 'PRODUCTION' THEN 'PRODUCTION'
    ELSE 'SANDBOX'
  END
WHERE payment_environment IS NULL;

-- Environment-aware background reconciliation: open attempts of one environment, oldest first.
-- idx_payments_open_for_reconciliation (005) is deliberately kept — the currently deployed
-- reconciler still uses it; it is dropped only in the later ENFORCE migration.
CREATE INDEX IF NOT EXISTS idx_payments_open_for_reconciliation_by_env
  ON payments (payment_environment, created_at)
  WHERE payment_status IN ('created', 'pending');
