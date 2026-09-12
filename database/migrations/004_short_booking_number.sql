-- Short booking number: a 4-digit, human-friendly customer/admin-facing booking reference.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001/002/003 — never automatically, never on deploy, see infra/lib/constructs/migration.ts. Run
-- inside its own transaction by the migration runner; if anything below fails, none of it applies
-- (and 001's/002's/003's tables/data are untouched either way).
--
-- Purely additive: no ALTER/DROP touches `id` or any other existing bookings column, and no
-- existing row's `id` (the real internal identifier — primary key, still what
-- simulator_allocations/payments/ownership/API URLs/PATCH status updates/every security check use)
-- is ever renumbered or replaced. `booking_number` is a second, parallel identifier that exists
-- *only* to be shown to a human (a customer reading their confirmation, an admin scanning a table)
-- — see this repo's CLAUDE.md for the architecture this migration must not violate.
--
-- Why a sequence, not a random/hashed number: the story asks for a small, easy-to-read 4-digit
-- range (1001-9999, 8999 possible values) with no collisions and no re-shuffling of existing
-- values — a SEQUENCE is the one Postgres primitive that hands out unique, monotonically
-- increasing integers under concurrent inserts without an app-level "SELECT MAX + 1" race. Bounded
-- with MINVALUE/MAXVALUE so Postgres itself refuses to hand out a number outside the 4-digit range
-- (NO CYCLE — once 9999 is exhausted, nextval() raises rather than silently wrapping back to 1001
-- and colliding with an already-issued number).

-- ============================================================================
-- Pre-flight guard — fail loudly, before touching any schema, if the existing bookings table
-- already has more rows than the 4-digit range can hold once backfilled. Doing this check up
-- front (rather than letting the backfill/sequence bounds below fail deep into the migration)
-- keeps the failure clear and keeps 001's/002's/003's data untouched either way, since nothing
-- past this point has run yet.
-- ============================================================================
DO $$
DECLARE
  existing_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO existing_count FROM bookings;
  -- 1001..9999 inclusive = 8999 distinct 4-digit numbers.
  IF existing_count > 8999 THEN
    RAISE EXCEPTION
      'Cannot backfill booking_number: % existing bookings exceed the available 4-digit range (1001-9999, 8999 values)',
      existing_count;
  END IF;
END $$;

-- ============================================================================
-- The sequence — the single authoritative generator for every booking_number, existing or future.
-- Frontend code must never send or choose one (see backend/src/handlers/create-booking.ts, whose
-- request body has no bookingNumber field at all) — the column DEFAULT below is what assigns one
-- to every new INSERT automatically, the same way `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
-- already does for the real identifier (001_initial_schema.sql).
-- ============================================================================
CREATE SEQUENCE booking_number_seq
  AS INTEGER
  START WITH 1001
  MINVALUE 1001
  MAXVALUE 9999
  NO CYCLE;

ALTER TABLE bookings ADD COLUMN booking_number INTEGER;

-- ============================================================================
-- Backfill — every booking that existed before this migration gets a unique booking_number,
-- assigned deterministically oldest-first (by created_at, then id to break an exact-timestamp
-- tie) so re-running this migration's backfill logic by hand would always reproduce the same
-- assignment. This runs once, here, and never again: nothing in this codebase ever re-numbers a
-- booking that already has one (create-booking.ts only ever INSERTs a new row; no UPDATE
-- statement anywhere touches booking_number).
-- ============================================================================
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS rn
  FROM bookings
)
UPDATE bookings b
SET booking_number = 1000 + ordered.rn
FROM ordered
WHERE b.id = ordered.id;

-- Advance the sequence past whatever was just backfilled, so the very next nextval() (the very
-- next new booking, via the DEFAULT added below) continues immediately after the last existing
-- booking_number instead of colliding with it. is_called = true means the NEXT nextval() call
-- returns this value + 1 — the standard "bump past what already exists" pattern. On a table with
-- no existing bookings, COALESCE falls back to 1000, so the first-ever nextval() below still
-- correctly returns 1001, matching a fresh install exactly as if this table had never had rows.
SELECT setval('booking_number_seq', GREATEST((SELECT COALESCE(MAX(booking_number), 1000) FROM bookings), 1000), true);

-- Every new booking gets its number for free from here on — create-booking.ts's INSERT never
-- lists booking_number and never needs to; Postgres fills it in from the sequence exactly like it
-- already does for `id`.
ALTER TABLE bookings ALTER COLUMN booking_number SET DEFAULT nextval('booking_number_seq');

-- Now that every existing row has a value and every future row will get one automatically, lock
-- the guarantees in as real constraints — not just as a side effect of the sequence's own bounds
-- — so they hold regardless of how a row was ever written:
--   - NOT NULL: no booking, old or new, is ever missing a customer-facing reference.
--   - the range check: defense in depth alongside the sequence's own MINVALUE/MAXVALUE, the same
--     "the sequence enforces it AND the schema enforces it" belt-and-braces pattern
--     001_initial_schema.sql already uses for price_inr/racers/duration_minutes.
--   - the unique index: no two bookings can ever carry the same booking_number, enforced by
--     Postgres itself rather than only by application logic (same rationale as
--     003_payment_foundation.sql's idx_payments_one_paid_per_booking).
ALTER TABLE bookings ALTER COLUMN booking_number SET NOT NULL;
ALTER TABLE bookings ADD CONSTRAINT bookings_booking_number_range_chk CHECK (booking_number BETWEEN 1001 AND 9999);
CREATE UNIQUE INDEX idx_bookings_booking_number_unique ON bookings (booking_number);

-- Ties the sequence's lifetime to the column it backs (so e.g. dropping the column also drops the
-- sequence instead of leaving it orphaned) — the same relationship a `GENERATED ... AS IDENTITY`
-- column gets automatically, made explicit here since booking_number was added as a plain column
-- with a DEFAULT rather than declared as IDENTITY from the start (IDENTITY can't backfill existing
-- rows the deterministic oldest-first way this migration requires).
ALTER SEQUENCE booking_number_seq OWNED BY bookings.booking_number;
