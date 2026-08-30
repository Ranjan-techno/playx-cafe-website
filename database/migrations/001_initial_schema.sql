-- Story 2.3: initial Play X schema — product catalog + bookings.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), never automatically
-- and never on deploy — see infra/lib/constructs/migration.ts. This file is the single source
-- of truth for both the versioned schema and the SQL the Lambda bundles and runs; don't
-- transcribe it elsewhere.
--
-- Out of scope by design (see the story): no `simulators`/allocation table — bookings never
-- pin a specific physical rig — and no payment table or columns.
--
-- Run inside one transaction by the migration runner; if anything below fails, none of it
-- applies.

-- ============================================================================
-- Enums
-- ============================================================================

-- The two shapes of sellable product. A timed simulator session, or the prepaid Race Pass
-- credit product (js/race-pass-config.js) — see the products_type_shape_chk constraint below
-- for which columns each shape requires.
CREATE TYPE product_type AS ENUM ('session', 'race_pass');

-- Static vs Motion rig. Nullable on both tables: NULL means "not tied to one simulator type"
-- (the Grand Race uses all four rigs at once; a Race Pass isn't tied to either).
CREATE TYPE simulator_type AS ENUM ('static', 'motion');

-- Fixed lifecycle for a booking, per the story.
CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');

-- ============================================================================
-- products — the sellable catalog: timed simulator sessions and the Race Pass.
-- ============================================================================

CREATE TABLE products (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable, human-readable identifier app code references (e.g. 'solo-pro-motion'), independent
  -- of the surrogate id — safe to hardcode in the booking form, unlike a UUID.
  product_code      TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  product_type      product_type NOT NULL,

  -- Session-only fields below (NULL for a race_pass row — enforced by the CHECK constraint).
  simulator_type    simulator_type,
  racers            SMALLINT CHECK (racers > 0),
  duration_minutes  SMALLINT CHECK (duration_minutes > 0),

  -- What the customer pays. Tax-inclusive, same rate every day — see PRICING_POLICY in
  -- js/pricing-config.js. Never a fractional paisa in the launch price list, but NUMERIC
  -- avoids float rounding regardless.
  price_inr         NUMERIC(10, 2) NOT NULL CHECK (price_inr >= 0),

  -- Race Pass-only fields below (NULL for a session row).
  credit_value_inr  NUMERIC(10, 2) CHECK (credit_value_inr >= price_inr),
  validity_days     SMALLINT CHECK (validity_days > 0),

  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Keeps the two product shapes from being mixed up: a session always has a duration and a
  -- racer count and never a credit value; a race pass is the exact opposite, and isn't tied to
  -- one simulator type.
  CONSTRAINT products_type_shape_chk CHECK (
    (
      product_type = 'session'
      AND duration_minutes IS NOT NULL
      AND racers IS NOT NULL
      AND credit_value_inr IS NULL
      AND validity_days IS NULL
    )
    OR
    (
      product_type = 'race_pass'
      AND duration_minutes IS NULL
      AND racers IS NULL
      AND simulator_type IS NULL
      AND credit_value_inr IS NOT NULL
      AND validity_days IS NOT NULL
    )
  )
);

CREATE INDEX idx_products_product_type ON products (product_type);

-- ============================================================================
-- bookings — a scheduled simulator session. Never a Race Pass purchase (that's a sale, not a
-- time-slot booking) — enforced by the enforce_booking_product_type trigger below.
-- ============================================================================

CREATE TABLE bookings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT: a product with booking history can be deactivated (is_active = false)
  -- but never deleted out from under those bookings.
  product_id          UUID NOT NULL REFERENCES products (id) ON DELETE RESTRICT,

  -- The authenticated identity that owns this booking: the verified "sub" claim from the
  -- caller's Cognito JWT (see backend/src/handlers/create-booking.ts, which reads it off
  -- event.requestContext.authorizer.jwt.claims.sub — never from the request body). This is the
  -- only authentication identifier on this table and the sole authority for "whose booking is
  -- this" — GET /bookings/me (backend/src/handlers/list-my-bookings.ts) scopes its query to
  -- WHERE b.cognito_sub = $1 and nothing else.
  cognito_sub         TEXT NOT NULL,

  -- Contact snapshot fields, not authentication identifiers — Play X uses Amazon Cognito
  -- (js/cognito-auth.js) for sign-in, and cognito_sub above is what identifies the account.
  -- Story 2.6's POST /bookings never collects a name or phone in the request body, so
  -- create-booking.ts currently inserts NULL for all three; they stay nullable and exist for a
  -- possible future booking-contact-details feature, not to identify who's logged in.
  customer_name       TEXT,
  customer_phone      TEXT,
  customer_email      TEXT,

  -- Snapshot of the product's session terms and price at booking time, so a later price or
  -- catalog change never rewrites booking history.
  racers              SMALLINT NOT NULL CHECK (racers > 0),
  duration_minutes    SMALLINT NOT NULL CHECK (duration_minutes > 0),
  simulator_type      simulator_type,
  price_inr           NUMERIC(10, 2) NOT NULL CHECK (price_inr >= 0),

  status              booking_status NOT NULL DEFAULT 'pending',

  -- No simulator/rig id here by design — which physical STATIC-0x/MOTION-0x unit a booking
  -- uses is out of scope for this story (no automatic simulator allocation).
  scheduled_start_at  TIMESTAMPTZ NOT NULL,
  scheduled_end_at    TIMESTAMPTZ NOT NULL CHECK (scheduled_end_at > scheduled_start_at),

  notes               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_product_id ON bookings (product_id);
CREATE INDEX idx_bookings_status ON bookings (status);
CREATE INDEX idx_bookings_scheduled_start_at ON bookings (scheduled_start_at);
-- Composite, for the common "upcoming pending/confirmed bookings in order" query — a single
-- index this order serves both a `WHERE status = ...` and a `WHERE status = ... ORDER BY
-- scheduled_start_at` query, which the two single-column indexes above can't do together.
CREATE INDEX idx_bookings_status_scheduled_start_at ON bookings (status, scheduled_start_at);
CREATE INDEX idx_bookings_customer_phone ON bookings (customer_phone);
-- Serves GET /bookings/me: "all bookings for this Cognito sub, most recent first" — this index
-- alone covers the equality filter on cognito_sub; ordering by scheduled_start_at within that
-- filter is a fast in-memory sort over a small per-user row count, so a composite index isn't
-- needed here (unlike idx_bookings_status_scheduled_start_at, which exists because that query
-- filters and sorts over the whole table).
CREATE INDEX idx_bookings_cognito_sub ON bookings (cognito_sub);

-- ============================================================================
-- Triggers
-- ============================================================================

CREATE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER bookings_set_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A CHECK constraint can't reference another table, so the "bookings only reference session
-- products" rule (never a race_pass) is enforced here instead.
CREATE FUNCTION enforce_booking_product_type() RETURNS TRIGGER AS $$
DECLARE
  referenced_type product_type;
BEGIN
  SELECT product_type INTO referenced_type FROM products WHERE id = NEW.product_id;
  IF referenced_type IS DISTINCT FROM 'session' THEN
    RAISE EXCEPTION 'bookings.product_id must reference a session product (got product_type = %)', referenced_type;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bookings_enforce_product_type
  BEFORE INSERT OR UPDATE OF product_id ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_product_type();

-- ============================================================================
-- Seed data — the finalized Play X launch pricing, transcribed exactly from
-- js/pricing-config.js (PRICING_GROUPS) and js/race-pass-config.js (RACE_PASS_PRODUCTS).
-- ON CONFLICT DO NOTHING makes re-running this file (e.g. after a partial failure) safe.
-- ============================================================================

INSERT INTO products
  (product_code, name, product_type, simulator_type, racers, duration_minutes, price_inr, credit_value_inr, validity_days)
VALUES
  -- Solo Racing Xperience — js/pricing-config.js PRICING_GROUPS[0] ('solo'), racers: 1
  ('solo-quick-static',      'Solo Racing Xperience — Quick Race (Static)',      'session', 'static', 1, 15, 399.00,  NULL, NULL),
  ('solo-quick-motion',      'Solo Racing Xperience — Quick Race (Motion)',      'session', 'motion', 1, 15, 599.00,  NULL, NULL),
  ('solo-pro-static',        'Solo Racing Xperience — Pro Race (Static)',        'session', 'static', 1, 30, 599.00,  NULL, NULL),
  ('solo-pro-motion',        'Solo Racing Xperience — Pro Race (Motion)',        'session', 'motion', 1, 30, 999.00,  NULL, NULL),
  ('solo-endurance-static',  'Solo Racing Xperience — Endurance (Static)',       'session', 'static', 1, 60, 999.00,  NULL, NULL),
  ('solo-endurance-motion',  'Solo Racing Xperience — Endurance (Motion)',       'session', 'motion', 1, 60, 1799.00, NULL, NULL),

  -- Race Together (Duo Xperience) — PRICING_GROUPS[1] ('duo'), racers: 2, price is for both racers
  ('duo-15-static',          'Race Together — Duo Xperience 15 min (Static)',    'session', 'static', 2, 15, 699.00,  NULL, NULL),
  ('duo-15-motion',          'Race Together — Duo Xperience 15 min (Motion)',    'session', 'motion', 2, 15, 1099.00, NULL, NULL),
  ('duo-30-static',          'Race Together — Duo Xperience 30 min (Static)',    'session', 'static', 2, 30, 1099.00, NULL, NULL),
  ('duo-30-motion',          'Race Together — Duo Xperience 30 min (Motion)',    'session', 'motion', 2, 30, 1799.00, NULL, NULL),

  -- Play X Grand Race (signature group Xperience) — PRICING_GROUPS[2] ('grand-race'), racers: 4,
  -- all 4 simulators, no Static/Motion split.
  ('grand-race-15',          'Play X Grand Race — 15 min',                       'session', NULL,     4, 15, 1799.00, NULL, NULL),
  ('grand-race-30',          'Play X Grand Race — 30 min',                       'session', NULL,     4, 30, 2799.00, NULL, NULL),

  -- Play X Race Pass — js/race-pass-config.js RACE_PASS_PRODUCTS[0]
  ('play-x-race-pass',       'Play X Race Pass',                                 'race_pass', NULL,   NULL, NULL, 2499.00, 2799.00, 90)
ON CONFLICT (product_code) DO NOTHING;
