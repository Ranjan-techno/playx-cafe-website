-- Duplicate (second) successful payment recording.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001-004 — never automatically, never on deploy. Run this BEFORE deploying the backend build
-- that records duplicate payments (that build writes payments.duplicate_of_payment_id).
--
-- Why: 003's idx_payments_one_paid_per_booking allowed at most ONE 'paid' row per booking. That
-- guarantee ("one payment confirms a booking once") is right for the PRIMARY payment, but it made
-- it impossible to record the truth when PhonePe later reports that a SECOND, historical order for
-- an already-paid booking was also collected: the write was rejected and the customer's money was
-- invisible to us. A second collected payment must be stored as PAID (it is), flagged for manual
-- refund, and linked to the payment that actually confirmed the booking.
--
-- The one-primary-payment-per-booking guarantee is kept: the unique index is narrowed to rows that
-- are not marked as duplicates, so a booking still can never have two primary payments (i.e. can
-- never be confirmed/allocated twice through the payment path). 'refunded' stays in the predicate
-- on purpose: refunding the primary payment later must not free the primary slot, otherwise a later
-- successful collection could be recorded as a second primary instead of a duplicate.

ALTER TABLE payments
  ADD COLUMN duplicate_of_payment_id UUID REFERENCES payments (id);

-- Only a payment that actually collected money can be a duplicate of another.
ALTER TABLE payments
  ADD CONSTRAINT payments_duplicate_requires_paid_chk
  CHECK (duplicate_of_payment_id IS NULL OR payment_status IN ('paid', 'refunded'));

-- A payment can never be a duplicate of itself. (Deliberately no cross-row trigger: the primary it
-- points at is validated by the application inside the payment+booking lock.)
ALTER TABLE payments
  ADD CONSTRAINT payments_duplicate_not_self_chk
  CHECK (duplicate_of_payment_id IS NULL OR duplicate_of_payment_id <> id);

DROP INDEX idx_payments_one_paid_per_booking;
CREATE UNIQUE INDEX idx_payments_one_paid_per_booking
  ON payments (booking_id)
  WHERE payment_status IN ('paid', 'refunded') AND duplicate_of_payment_id IS NULL;

-- Background reconciliation (backend/src/handlers/payment-reconcile.ts) selects only open
-- attempts; this keeps that scan off the (growing) set of terminal rows.
CREATE INDEX idx_payments_open_for_reconciliation
  ON payments (created_at)
  WHERE payment_status IN ('created', 'pending');

-- Payment environment marker. Admin revenue and refund-exposure totals exclude
-- metadata.paymentEnvironment = 'SANDBOX' (see backend/src/lib/admin-repository.ts); new payments
-- get the marker at creation (start-payment.ts). PhonePe PRODUCTION has never been enabled, so every
-- existing PhonePe row was created in sandbox/Test Mode. Never overwrites an existing marker.
UPDATE payments
SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"paymentEnvironment": "SANDBOX"}'::jsonb
WHERE provider = 'phonepe'
  AND (metadata IS NULL OR NOT (metadata ? 'paymentEnvironment'));
