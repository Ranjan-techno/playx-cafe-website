-- Stage 2G: SES delivery tracking for the booking-confirmation email.
--
-- Applied by the migration Lambda (infra/lib/lambda/migrate/handler.ts), same mechanism as 001-008 —
-- never automatically, never on deploy. ADDITIVE ONLY: nullable columns on booking_notifications
-- (migration 008), each with its own CHECK. No existing column, constraint or row is altered, and
-- no other table is touched.
--
-- WHAT IT RECORDS: what happened to a booking-confirmation email AFTER SES accepted it — the SES
-- event-publishing events (Send / Delivery / DeliveryDelay / Bounce / Complaint / Reject /
-- Rendering Failure) that the SES configuration set publishes to EventBridge and the dedicated
-- booking-email-events Lambda (backend/src/handlers/booking-email-events.ts) applies here.
-- OPERATIONAL OBSERVABILITY ONLY: nothing that reads these columns ever changes a payment, a booking,
-- a simulator allocation or revenue.
--
-- TWO INDEPENDENT STATES:
--   status           (008) the outbox: pending / sent / failed / suppressed — did WE hand it to SES?
--   delivery_status  (009) what SES reported afterwards:
--     NULL              not tracked — every row sent before Stage 2G, or sent with tracking off
--     accepted          SES accepted it (status = 'sent'); final mailbox delivery not yet known
--     delayed           a temporary delivery problem; SES is still retrying
--     delivered         the recipient's mail server accepted it
--     bounced           terminal
--     complained        terminal (the recipient marked it as spam)
--     rejected          terminal (SES refused to deliver, e.g. virus)
--     rendering_failed  terminal (template rendering failure)
--   Transitions only move forward — see backend/src/lib/booking-email-events.ts.
--
-- NO BACKFILL — deliberately. Rows sent before Stage 2G stay delivery_status NULL ("delivery not
-- tracked"); nothing here claims a historical email was delivered, and there is no UPDATE below.
--
-- NO RAW PROVIDER DATA: no raw SES event JSON, SMTP response, diagnostic code, reporting MTA or
-- recipient list is stored — only the status, SES's event timestamps and a short, charset-restricted
-- failure type/subtype (e.g. 'Permanent' / 'General') for support.
--
-- DEPLOY ORDER: apply this migration BEFORE the Stage 2G code is deployed (the sender's 'sent' update
-- writes delivery_status). Every column is nullable with no DEFAULT, so the currently deployed Stage
-- 2F code is unaffected by it.
--
-- Idempotency of the file itself: the runner applies it at most once, in its own transaction (the
-- columns are ADD COLUMN IF NOT EXISTS; the final ADD CONSTRAINT relies on that at-most-once run).

ALTER TABLE booking_notifications
  ADD COLUMN IF NOT EXISTS delivery_status TEXT
    CONSTRAINT booking_notifications_delivery_status_chk CHECK (
      delivery_status IS NULL
      OR delivery_status IN ('accepted', 'delivered', 'delayed', 'bounced', 'complained', 'rejected', 'rendering_failed')
    ),
  -- SES's own timestamp of the most recent event that changed delivery_status.
  ADD COLUMN IF NOT EXISTS last_delivery_event_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS complained_at TIMESTAMPTZ,
  -- e.g. 'Permanent' / 'Transient' / 'Undetermined' (bounce), 'Complaint', 'Reject', 'DeliveryDelay',
  -- 'RenderingFailure'. Never free text, an address or an SMTP response.
  ADD COLUMN IF NOT EXISTS delivery_failure_type TEXT
    CONSTRAINT booking_notifications_delivery_failure_type_chk CHECK (
      delivery_failure_type IS NULL OR delivery_failure_type ~ '^[A-Za-z0-9 _.-]{1,64}$'
    ),
  -- e.g. 'General' / 'NoEmail' / 'Suppressed' (bounce), 'abuse' (complaint), 'MailboxFull' (delay).
  ADD COLUMN IF NOT EXISTS delivery_failure_subtype TEXT
    CONSTRAINT booking_notifications_delivery_failure_subtype_chk CHECK (
      delivery_failure_subtype IS NULL OR delivery_failure_subtype ~ '^[A-Za-z0-9 _.-]{1,64}$'
    );

-- Delivery evidence only ever exists for a message SES accepted (outbox status 'sent'). A separate,
-- table-level constraint because it spans two columns. Every existing row has delivery_status NULL,
-- so it validates without touching any row.
ALTER TABLE booking_notifications
  ADD CONSTRAINT booking_notifications_delivery_requires_sent_chk CHECK (delivery_status IS NULL OR status = 'sent');
