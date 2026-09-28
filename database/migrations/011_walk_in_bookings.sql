-- Stage 3A.1 (walk-in bookings), step 2 of 2: the walk-in booking model and counter payment method.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001-010 — never automatically, never on deploy, see infra/lib/constructs/migration.ts. Run inside
-- its own transaction by the migration runner; if anything below fails, none of it applies.
-- Requires 010_counter_payment_provider.sql to have COMMITTED first (see its header).
--
-- Walk-ins use the SAME bookings / booking_allocations / payments tables and the same simulator
-- inventory and allocation code as online bookings (see backend/src/lib/walk-in-booking.ts); the
-- only new facts are where a booking came from and how a counter payment was taken.
--
-- Additive, no backfill of business data:
--   - bookings.booking_source is NOT NULL DEFAULT 'ONLINE': every existing row reads as ONLINE
--     (a constant DEFAULT is metadata-only in PostgreSQL 11+ — no table rewrite, no UPDATE).
--   - bookings.created_by_admin_sub and payments.payment_method are new, nullable, no DEFAULT:
--     every existing row keeps NULL.
--   - bookings.cognito_sub loses NOT NULL, but bookings_source_identity_chk immediately re-requires
--     it for every ONLINE booking — so online authentication is exactly as strict as before; only a
--     WALK_IN row (which has no customer Cognito account) may, and must, leave it NULL.
-- Every existing row satisfies every new constraint as-is (ONLINE + non-NULL cognito_sub + NULL
-- created_by_admin_sub; phonepe/mock payments + NULL payment_method), so validation needs no data
-- change.
--
-- Out of scope (Stage 3A): discounts, refunds, partial payments, deposits, walk-in email.

-- ============================================================================
-- bookings — where a booking came from, and who recorded a walk-in.
-- ============================================================================

ALTER TABLE bookings
  ADD COLUMN booking_source TEXT NOT NULL DEFAULT 'ONLINE'
    CONSTRAINT bookings_booking_source_chk CHECK (booking_source IN ('ONLINE', 'WALK_IN'));

-- The verified Cognito `sub` of the admin who created a walk-in (authorizeAdmin's sub). An audit
-- field, never an ownership field: GET /bookings/me scopes on cognito_sub only, so a walk-in can
-- never appear in the recording admin's (or anyone's) My Bookings.
ALTER TABLE bookings
  ADD COLUMN created_by_admin_sub TEXT;

ALTER TABLE bookings
  ALTER COLUMN cognito_sub DROP NOT NULL;

-- ONLINE: owned by a customer account, never admin-created.
-- WALK_IN: no customer account, always admin-created, and always has the contact details the
-- counter collects (name + phone; email optional).
ALTER TABLE bookings
  ADD CONSTRAINT bookings_source_identity_chk CHECK (
    (
      booking_source = 'ONLINE'
      AND cognito_sub IS NOT NULL
      AND created_by_admin_sub IS NULL
    )
    OR
    (
      booking_source = 'WALK_IN'
      AND cognito_sub IS NULL
      AND created_by_admin_sub IS NOT NULL
      AND customer_name IS NOT NULL
      AND customer_phone IS NOT NULL
    )
  );

-- ============================================================================
-- payments — how a counter payment was taken. NULL for every PhonePe/mock attempt.
-- ============================================================================

ALTER TABLE payments
  ADD COLUMN payment_method TEXT
    CONSTRAINT payments_payment_method_chk CHECK (payment_method IN ('CASH', 'UPI', 'CARD', 'COMPLIMENTARY'));

-- A counter payment always says how it was taken, and only a counter payment carries a method
-- (existing phonepe/mock rows stay NULL).
ALTER TABLE payments
  ADD CONSTRAINT payments_counter_method_chk CHECK ((provider = 'counter') = (payment_method IS NOT NULL));

-- A counter payment is recorded only once the money (or the complimentary decision) is final at the
-- desk: never an open 'created'/'pending' attempt a reconciler could pick up.
ALTER TABLE payments
  ADD CONSTRAINT payments_counter_final_chk CHECK (provider <> 'counter' OR payment_status IN ('paid', 'refunded'));

-- Complimentary is explicitly ₹0 collected; the booking row keeps the list price (bookings.price_inr)
-- so the value given away stays reportable.
ALTER TABLE payments
  ADD CONSTRAINT payments_complimentary_zero_chk CHECK (payment_method IS DISTINCT FROM 'COMPLIMENTARY' OR amount_inr = 0);
