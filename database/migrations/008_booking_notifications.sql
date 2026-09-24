-- Stage 2F: booking_notifications — a durable, per-booking outbox for the transactional
-- booking-confirmation email.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as
-- 001-007 — never automatically, never on deploy. ADDITIVE ONLY: one new table, two indexes. No
-- existing table, column, constraint or row is altered.
--
-- HOW ROWS GET HERE: backend/src/lib/confirm-successful-payment.ts inserts exactly one
-- ('BOOKING_CONFIRMED', status 'pending') row, INSIDE the same transaction that turns a verified
-- successful payment into payment=PAID + booking=CONFIRMED — so a row exists if and only if that
-- confirmation committed (a transactional outbox). No email is ever sent inside that transaction:
-- the scheduled sender (backend/src/handlers/booking-confirmation-notify.ts) picks pending rows up
-- afterwards and sends through the existing SES identity.
--
-- IDEMPOTENCY: UNIQUE (booking_id, notification_type) — the insert is ON CONFLICT DO NOTHING, so the
-- webhook, the status poll, the fast SQS chain, the 5-minute reconcilers and duplicate PhonePe
-- callbacks can all observe the same success and there is still only ONE logical notification per
-- booking. The sender claims rows with FOR UPDATE SKIP LOCKED plus a lease (next_attempt_at), and
-- only a 'pending' row can move to 'sent'.
--
-- EXISTING BOOKINGS ARE NOT BACKFILLED — deliberately. Bookings confirmed before this migration
-- (e.g. #1033, #1034) get no row, so they are never emailed when Stage 2F activates. Only bookings
-- whose confirmation transaction runs after both the Stage 2F code and this migration are live get
-- a row. To email an existing booking on purpose, insert its row by hand:
--   INSERT INTO booking_notifications (booking_id, notification_type)
--   VALUES ('<bookings.id>', 'BOOKING_CONFIRMED') ON CONFLICT DO NOTHING;
--
-- DEPLOY ORDER: this migration is applied BEFORE the Stage 2F application code is deployed (it ships
-- alone in its own commit/deploy first; nothing in the currently deployed code reads this table).
-- The outbox insert still runs under a SAVEPOINT so it can never fail a payment confirmation, but a
-- missing table is treated as abnormal: the insert logs an error and the sender run fails (alarm).
--
-- Idempotency of the file itself: the runner applies it at most once, in its own transaction; the
-- statements are IF NOT EXISTS regardless.

CREATE TABLE IF NOT EXISTS booking_notifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- ON DELETE RESTRICT, like payments: notification history never silently disappears.
  booking_id          UUID NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,

  notification_type   TEXT NOT NULL
    CONSTRAINT booking_notifications_type_chk CHECK (notification_type IN ('BOOKING_CONFIRMED')),

  --   pending    - waiting to be (re)tried by the sender; next_attempt_at says when
  --   sent       - SES accepted the message (terminal)
  --   failed     - gave up: retries exhausted or a permanent error (terminal; logged + alarmed)
  --   suppressed - deliberately not sent: SANDBOX booking without an allowlisted recipient, booking
  --                no longer confirmed, session already over, or the row went stale (terminal)
  status              TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT booking_notifications_status_chk CHECK (status IN ('pending', 'sent', 'failed', 'suppressed')),

  -- The verified Cognito account email the sender resolved from bookings.cognito_sub at send time
  -- (never request/webhook data). NULL until a send is attempted.
  recipient_email     TEXT,

  attempt_count       INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  -- Earliest time the sender may (re)claim a pending row. Claiming pushes it forward by a lease, so
  -- an overlapping run never picks up a row another run is still sending.
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at     TIMESTAMPTZ,
  -- A short reason code or error class name only — never an email body, address or provider text.
  last_error          TEXT,
  -- SES MessageId of the accepted send (support traceability).
  provider_message_id TEXT,
  sent_at             TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT booking_notifications_booking_type_unique UNIQUE (booking_id, notification_type)
);

-- The sender's claim query: due pending rows, oldest first.
CREATE INDEX IF NOT EXISTS idx_booking_notifications_pending_due
  ON booking_notifications (next_attempt_at)
  WHERE status = 'pending';
