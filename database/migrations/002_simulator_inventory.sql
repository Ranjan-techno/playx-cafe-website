-- Phase 2: automated simulator availability and allocation.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001_initial_schema.sql — never automatically, never on deploy, see infra/lib/constructs/
-- migration.ts. Run inside its own transaction by the migration runner; if anything below
-- fails, none of it applies (and 001's tables/data are untouched either way).
--
-- Purely additive: no ALTER/DROP touches `products` or `bookings`, and no existing row is
-- modified or deleted — existing booking history survives this migration unchanged. This is
-- what makes the migration non-destructive: `bookings` still has no simulator/rig id of its
-- own (see 001's comment on that), and now never needs one — which physical rig(s) a booking
-- uses lives entirely in the new `booking_allocations` table below, joined back to `bookings`
-- by `booking_id`.
--
-- Out of scope by design (matches the story): no admin UI, no payment table/columns. The HOLD
-- lifecycle here (allocation_status/hold_expires_at) is the reserve-before-pay building block a
-- future payment story will drive; today, backend/src/handlers/create-booking.ts is the only
-- writer, and it creates a HOLD per simulator whose 15-minute expiry mirrors the fact that a
-- 'pending' booking (see 001's booking_status) has no confirmation step yet either.
--
-- Existing (pre-Phase-2) bookings: this migration is purely additive and deliberately does NOT
-- backfill booking_allocations for bookings that already existed before it ran — there is nothing
-- reliable to backfill. The pre-Phase-2 flow never recorded which physical rig a booking used (see
-- 001's "no simulator/rig id" note), so a backfilled simulator_id here would be fabricated data,
-- not a fact recovered from history — including for the 'pending' status, the only one the app has
-- ever written (see create-booking.ts). Instead, backend/src/lib/allocate-simulators.ts and
-- backend/src/handlers/availability.ts both separately query `bookings` for any row with no
-- booking_allocations rows of its own (status <> 'cancelled', window-overlapping) and count it
-- against capacity by type/count (via requirementForProduct on the booking's own snapshot
-- simulator_type/racers columns) without ever claiming a specific simulator id for it. A future
-- booking made under the old flow keeps blocking inventory this way; a past one never matters
-- (its window can no longer overlap any new request). See allocate-simulators.ts's header for the
-- exact query and why it's safe under concurrency.

-- ============================================================================
-- Enums
-- ============================================================================

-- Lifecycle of one physical-simulator reservation (a single booking_allocations row), distinct
-- from bookings.status (001's booking_status): a booking can hold several simulators (Duo, Grand
-- Race) and each one tracks its own allocation lifecycle.
--   'hold'      — reserved, blocks inventory only while hold_expires_at is still in the future.
--   'confirmed' — reserved indefinitely (no expiry); reserved for a future payment/staff-confirm
--                 step (see api.ts/create-booking.ts headers) — nothing writes this value yet.
--   'released'  — no longer blocks inventory; reserved for a future booking-cancellation step —
--                 nothing writes this value yet either.
CREATE TYPE allocation_status AS ENUM ('hold', 'confirmed', 'released');

-- ============================================================================
-- simulators — the physical inventory: 2 Static rigs (S1, S2) + 2 Motion rigs (M1, M2).
-- ============================================================================

CREATE TABLE simulators (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable short code (e.g. 'S1', 'M2') — what allocation logs/responses reference, independent
  -- of the surrogate id, same pattern as products.product_code.
  code              TEXT NOT NULL UNIQUE,

  -- Reuses 001's simulator_type enum (already 'static'/'motion') rather than defining a second,
  -- identical one. NOT NULL here (unlike products.simulator_type/bookings.simulator_type, which
  -- are nullable to mean "not tied to one type") — every physical rig is exactly one type.
  simulator_type    simulator_type NOT NULL,

  -- Lets a rig be taken out of the allocation pool (maintenance, decommission) without deleting
  -- it out from under historical booking_allocations rows — same rationale as
  -- products.is_active.
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves "the active rigs of one type" — the first query allocation always runs (see
-- backend/src/lib/allocate-simulators.ts and backend/src/handlers/availability.ts).
CREATE INDEX idx_simulators_type_active ON simulators (simulator_type, is_active);

CREATE TRIGGER simulators_set_updated_at
  BEFORE UPDATE ON simulators
  -- set_updated_at() already exists — defined by 001_initial_schema.sql, reused as-is.
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- booking_allocations — which physical simulator(s) a booking occupies, and for how long.
-- A Solo booking has 1 row, a Duo booking has 2, a Grand Race booking has 4 (one per rig).
-- ============================================================================

CREATE TABLE booking_allocations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE CASCADE: an allocation has no meaning without its booking (unlike
  -- bookings.product_id -> products, which is ON DELETE RESTRICT because a product can outlive
  -- its bookings; a booking_allocations row never should outlive its booking).
  booking_id          UUID NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,

  -- ON DELETE RESTRICT, mirroring bookings.product_id: a rig with allocation history can be
  -- deactivated (simulators.is_active = false) but never deleted out from under it.
  simulator_id        UUID NOT NULL REFERENCES simulators (id) ON DELETE RESTRICT,

  -- Denormalized copy of the parent booking's scheduled_start_at/scheduled_end_at at allocation
  -- time. Kept on this table (not just joined from bookings) because the availability/allocation
  -- queries filter and lock by time window per simulator — see allocate-simulators.ts — and
  -- indexing this table directly avoids a join for every one of those.
  scheduled_start_at  TIMESTAMPTZ NOT NULL,
  scheduled_end_at    TIMESTAMPTZ NOT NULL CHECK (scheduled_end_at > scheduled_start_at),

  allocation_status   allocation_status NOT NULL DEFAULT 'hold',

  -- NULL once an allocation leaves the 'hold' state (nothing does that yet — see the enum
  -- comment above). A HOLD with hold_expires_at in the past no longer blocks inventory (see the
  -- availability/allocation queries' "allocation_status = 'confirmed' OR (allocation_status =
  -- 'hold' AND hold_expires_at > now())" filter) but the row itself is never deleted or rewritten
  -- by expiry — same "never silently rewrite history" rationale as bookings' price/duration
  -- snapshot columns.
  hold_expires_at     TIMESTAMPTZ,
  CONSTRAINT booking_allocations_hold_expiry_chk CHECK (
    (allocation_status = 'hold') = (hold_expires_at IS NOT NULL)
  ),

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_booking_allocations_booking_id ON booking_allocations (booking_id);

-- Serves the allocation/availability overlap query (allocate-simulators.ts/availability.ts):
-- "every blocking allocation across ALL simulators whose window overlaps [start, end)" — neither
-- query ever filters WHERE simulator_id = <one rig>; occupancy is computed for the whole inventory
-- at once and simulator_id is only read back to attribute each row in application code. That's why
-- scheduled_start_at/scheduled_end_at (the columns the WHERE clause actually ranges over) lead —
-- leading with simulator_id instead (as a "one simulator at a time" access pattern might suggest)
-- would buy nothing here, since there's no equality predicate on it to seek by, and would cost the
-- range scan its ability to use scheduled_start_at as a seek bound. simulator_id trails only so
-- the index alone can satisfy the query's SELECT list (index-only scan, no heap fetch).
CREATE INDEX idx_booking_allocations_window ON booking_allocations (scheduled_start_at, scheduled_end_at, simulator_id);

-- Serves "is this HOLD still active" without a full scan once a HOLD dataset grows.
CREATE INDEX idx_booking_allocations_status_hold_expires ON booking_allocations (allocation_status, hold_expires_at);

CREATE TRIGGER booking_allocations_set_updated_at
  BEFORE UPDATE ON booking_allocations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- Seed data — the Phase 2 physical inventory (S1/S2 Static, M1/M2 Motion). ON CONFLICT DO
-- NOTHING makes re-running this file (e.g. after a partial failure) safe, same as 001's seed.
-- ============================================================================

INSERT INTO simulators (code, simulator_type)
VALUES
  ('S1', 'static'),
  ('S2', 'static'),
  ('M1', 'motion'),
  ('M2', 'motion')
ON CONFLICT (code) DO NOTHING;
