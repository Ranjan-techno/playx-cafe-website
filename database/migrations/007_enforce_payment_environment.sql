-- Payment environment columns — ENFORCE step of the EXPAND -> CODE -> ENFORCE rollout begun in
-- 006_payment_environment_expansion.sql.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001-006 — never automatically, never on deploy.
--
-- Preconditions (Stage 1B, already deployed and verified in staging before this runs):
--   * create-booking writes bookings.booking_environment = 'SANDBOX' explicitly on every insert,
--   * payment-start writes payments.payment_environment = 'SANDBOX' explicitly on every insert,
--   * reconciliation/accounting read the typed columns (environment-aware index from 006).
-- So the only NULLs left are legacy rows written by the pre-1B code between 006 and the 1B deploy.
-- PhonePe PRODUCTION has never been enabled, so every such NULL is SANDBOX.
--
-- What this does:
--   * backfills any remaining NULLs to SANDBOX, then sets both columns NOT NULL — still with NO
--     DEFAULT: the application must always state the environment explicitly, and an insert that
--     forgets it now fails loudly instead of being silently stamped with a guessed environment;
--   * leaves 006's CHECK constraints (bookings_booking_environment_chk,
--     payments_payment_environment_chk) exactly as they are;
--   * drops 005's environment-blind idx_payments_open_for_reconciliation, superseded by 006's
--     idx_payments_open_for_reconciliation_by_env (kept) now that the deployed reconciler filters
--     by payment_environment.
--
-- Deliberately NOT done here: backend/src/lib/environment.ts's TRANSITIONAL_NULL_IS_SANDBOX stays
-- true until this migration has been applied and verified; that code cleanup follows separately.
-- It is harmless meanwhile — with NOT NULL in place its NULL branches simply never match.
--
-- Idempotency: the runner applies each file at most once, in its own transaction, so the backfill
-- and NOT NULL either both land or neither does. The statements are also re-run safe on their own
-- (UPDATE ... WHERE IS NULL, SET NOT NULL on an already NOT NULL column, DROP INDEX IF EXISTS).

-- ---------------------------------------------------------------------------------------------
-- bookings.booking_environment
-- ---------------------------------------------------------------------------------------------

UPDATE bookings
SET booking_environment = 'SANDBOX'
WHERE booking_environment IS NULL;

ALTER TABLE bookings
  ALTER COLUMN booking_environment SET NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- payments.payment_environment
-- ---------------------------------------------------------------------------------------------

UPDATE payments
SET payment_environment = 'SANDBOX'
WHERE payment_environment IS NULL;

ALTER TABLE payments
  ALTER COLUMN payment_environment SET NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- Reconciliation index cleanup
-- ---------------------------------------------------------------------------------------------

-- Environment-blind (005); superseded by idx_payments_open_for_reconciliation_by_env (006, kept).
DROP INDEX IF EXISTS idx_payments_open_for_reconciliation;
