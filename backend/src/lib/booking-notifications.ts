// Stage 2F: the transactional booking-confirmation email — outbox (enqueue) + sender (deliver).
//
// TRIGGER: only confirmSuccessfulPayment() (confirm-successful-payment.ts) calls
// enqueueBookingConfirmedNotification(), inside its own transaction, on the branches that leave
// payment = PAID and booking = CONFIRMED for the first time. That function is the single path every
// verified success goes through (webhook, status poll, fast SQS chain, 5-minute reconcilers) — the
// browser's return from PhonePe, a callback payload or a query string never reach it on their own
// say-so. A duplicate success (payment already 'paid') returns before enqueueing anything, and the
// UNIQUE (booking_id, notification_type) + ON CONFLICT DO NOTHING makes any second insert a no-op.
//
// NEVER BREAKS A CONFIRMATION: the insert runs under a SAVEPOINT. If it fails for any reason, only
// the savepoint is rolled back and the confirmation commits exactly as before — the notification is
// a side effect, never a precondition. The rollout applies migration 008 BEFORE this code ships, so
// a failed insert is abnormal: it is logged as an error (that booking gets no email), never silently
// treated as expected.
//
// DELIVERY (processDueNotifications, driven by handlers/booking-confirmation-notify.ts on a 1-minute
// schedule — no SES call ever happens inside the confirmation transaction):
//   claim   one autocommitted UPDATE ... FOR UPDATE SKIP LOCKED that bumps attempt_count and pushes
//           next_attempt_at forward by a lease, so overlapping runs never claim the same row;
//   decide  re-read the booking: still CONFIRMED with a primary PAID payment, session not over, row
//           not stale, else 'suppressed'. SANDBOX bookings are suppressed unless the resolved
//           recipient is on BOOKING_EMAIL_SANDBOX_ALLOWLIST (empty by default: staging never emails
//           real customers);
//   send    recipient = the verified email of the Cognito account that owns the booking
//           (bookings.cognito_sub -> AdminGetUser), never the free-text contact email and never
//           anything from a request or webhook; SES through the existing verified sender;
//   record  'sent' (only from 'pending'), or back to 'pending' with backoff, or 'failed' once
//           retries are exhausted / the error is permanent.
// Nothing here ever reads or writes payments or bookings state — a failed email cannot un-pay or
// un-confirm anything.
//
// At-most-once is not achievable around an external send; the one remaining duplicate window is a
// crash after SES accepted the message but before 'sent' was recorded (the row is re-claimed once
// its lease lapses). Everything else — duplicate successes, overlapping runs, retries after a
// recorded failure — yields one email.
//
// LOGS: event name, notification id, booking id (internal UUIDs), status/reason codes and error
// class names. Never the recipient address, the email body, tokens or credentials.

import type { DbClient } from './allocate-simulators';
import type { AppEnvironment } from './environment';
import { inrToPaise } from './money';

export const BOOKING_CONFIRMED = 'BOOKING_CONFIRMED';

export type EnqueueResult = 'queued' | 'already_queued' | 'not_queued';

const SAVEPOINT = 'booking_confirmation_notification';

/**
 * Records that booking `bookingId` needs its confirmation email. MUST be called inside the caller's
 * open transaction (confirmSuccessfulPayment), after the booking is confirmed and before COMMIT, so
 * the row commits or rolls back together with the confirmation. Never throws for an insert
 * failure — see the module header.
 */
export async function enqueueBookingConfirmedNotification(db: DbClient, bookingId: string): Promise<EnqueueResult> {
  await db.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO booking_notifications (booking_id, notification_type)
       VALUES ($1, '${BOOKING_CONFIRMED}')
       ON CONFLICT (booking_id, notification_type) DO NOTHING
       RETURNING id`,
      [bookingId],
    );
    await db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return rows.length > 0 ? 'queued' : 'already_queued';
  } catch (err) {
    // If even this fails the connection is unusable; let it propagate so the caller rolls back.
    await db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    console.error(
      'booking confirmation notification not queued (unexpected; confirmation unaffected)',
      JSON.stringify({ bookingId, error: errorName(err), code: pgCode(err) }),
    );
    return 'not_queued';
  }
}

// ------------------------------------------------------------------------------------------------
// Sender
// ------------------------------------------------------------------------------------------------

/** What the email needs about one booking — all server-side data. */
export interface BookingConfirmationDetails {
  bookingNumber: number;
  productName: string;
  simulatorType: 'static' | 'motion' | null;
  racers: number;
  durationMinutes: number;
  scheduledStartAt: Date;
  scheduledEndAt: Date;
  /** The primary PAID payment's amount (payments.amount_inr), rupees as NUMERIC text. */
  amountPaidInr: string;
}

export interface VerifiedRecipient {
  email: string;
}

export type RecipientResolution =
  | { kind: 'verified'; recipient: VerifiedRecipient }
  /** No account matched YET (Cognito ListUsers is eventually consistent) — retried with backoff. */
  | { kind: 'not_found' }
  /** The Cognito account is gone or has no verified email — retrying cannot help. */
  | { kind: 'unavailable' };

export interface NotificationSender {
  /** Sends the confirmation email; resolves to the SES MessageId. Throws on failure. */
  sendBookingConfirmation(to: string, details: BookingConfirmationDetails): Promise<string | undefined>;
}

export interface NotificationDeps {
  db: DbClient;
  /** Looks up the verified email of the Cognito account `cognitoSub`. Throws on transient errors. */
  resolveRecipient: (cognitoSub: string) => Promise<RecipientResolution>;
  sender: NotificationSender;
  /** Lower-cased emails SANDBOX confirmations may go to. Empty = every SANDBOX email suppressed. */
  sandboxAllowlist: ReadonlySet<string>;
  now?: () => Date;
  /** Stop claiming new batches when this returns false (Lambda time budget). */
  hasTimeLeft?: () => boolean;
}

export const NOTIFICATION_BATCH_SIZE = 10;
/** Longer than the sender Lambda's timeout, so a claimed row is never re-claimed mid-send. */
export const CLAIM_LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 8;
/** A confirmation older than this is no longer news — suppressed instead of sent (e.g. the sender
 *  was disabled for a while and is switched back on). */
export const MAX_NOTIFICATION_AGE_MS = 48 * 60 * 60_000;

/** Delay before retry number `attempt + 1`: 1, 2, 4, 8, 16, 32, 60, 60 ... minutes. */
export function retryDelaySeconds(attemptCount: number): number {
  const minutes = Math.min(60, 2 ** Math.max(0, attemptCount - 1));
  return minutes * 60;
}

/** SES errors no retry can fix (a rejected recipient/message). Everything else is retried. */
const PERMANENT_SEND_ERRORS = new Set(['MessageRejected', 'InvalidParameterValue']);

export interface ClaimedNotification {
  id: string;
  booking_id: string;
  attempt_count: number;
  created_at: Date;
}

interface BookingNotificationRow {
  id: string;
  booking_number: number;
  status: string;
  cognito_sub: string;
  booking_environment: string | null;
  simulator_type: 'static' | 'motion' | null;
  racers: number;
  duration_minutes: number;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  product_name: string;
  amount_paid_inr: string | null;
}

export type NotificationOutcome =
  | { result: 'sent' }
  | { result: 'suppressed'; reason: string }
  | { result: 'retry'; reason: string }
  | { result: 'failed'; reason: string };

export interface NotificationRunSummary {
  claimed: number;
  sent: number;
  suppressed: number;
  retried: number;
  failed: number;
}

/** booking_notifications does not exist: migration 008 was not applied before the sender was
 *  deployed, which the rollout forbids. Thrown so the run fails and the Errors alarm fires. */
export class NotificationsTableMissingError extends Error {
  constructor() {
    super('booking_notifications table is missing (migration 008 not applied)');
    this.name = 'NotificationsTableMissingError';
  }
}

export async function claimDueNotifications(db: DbClient, limit: number): Promise<ClaimedNotification[]> {
  const { rows } = await db.query<ClaimedNotification>(
    `UPDATE booking_notifications n
     SET attempt_count = n.attempt_count + 1,
         last_attempt_at = now(),
         next_attempt_at = now() + make_interval(secs => $2),
         updated_at = now()
     WHERE n.id IN (
       SELECT id FROM booking_notifications
       WHERE status = 'pending' AND notification_type = '${BOOKING_CONFIRMED}' AND next_attempt_at <= now()
       ORDER BY next_attempt_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING n.id, n.booking_id, n.attempt_count, n.created_at`,
    [limit, CLAIM_LEASE_SECONDS],
  );
  return rows;
}

async function loadBookingForNotification(db: DbClient, bookingId: string): Promise<BookingNotificationRow | undefined> {
  const { rows } = await db.query<BookingNotificationRow>(
    `SELECT b.id, b.booking_number, b.status, b.cognito_sub, b.booking_environment, b.simulator_type,
            b.racers, b.duration_minutes, b.scheduled_start_at, b.scheduled_end_at,
            p.name AS product_name,
            (SELECT pay.amount_inr FROM payments pay
              WHERE pay.booking_id = b.id AND pay.payment_status = 'paid' AND pay.duplicate_of_payment_id IS NULL
              ORDER BY pay.paid_at LIMIT 1) AS amount_paid_inr
     FROM bookings b
     JOIN products p ON p.id = b.product_id
     WHERE b.id = $1`,
    [bookingId],
  );
  return rows[0];
}

async function markSent(db: DbClient, id: string, recipientEmail: string, messageId: string | undefined): Promise<void> {
  await db.query(
    `UPDATE booking_notifications
     SET status = 'sent', sent_at = now(), recipient_email = $2, provider_message_id = $3, last_error = NULL, updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, recipientEmail, messageId ?? null],
  );
}

async function markTerminal(db: DbClient, id: string, status: 'failed' | 'suppressed', reason: string): Promise<void> {
  await db.query(
    `UPDATE booking_notifications
     SET status = $2, last_error = $3, updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, status, reason],
  );
}

async function markRetry(db: DbClient, id: string, reason: string, delaySeconds: number): Promise<void> {
  await db.query(
    `UPDATE booking_notifications
     SET last_error = $2, next_attempt_at = now() + make_interval(secs => $3), updated_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [id, reason, delaySeconds],
  );
}

function isSendable(environment: string | null, recipient: string, allowlist: ReadonlySet<string>): boolean {
  const env = environment as AppEnvironment | null;
  if (env === 'PRODUCTION') {
    return true;
  }
  return env === 'SANDBOX' && allowlist.has(recipient.toLowerCase());
}

function hasValidAmount(value: string | null): value is string {
  if (value === null) {
    return false;
  }
  try {
    inrToPaise(value);
    return true;
  } catch {
    return false;
  }
}

/** One claimed row, start to finish. Only DB errors while recording an outcome throw. */
export async function processNotification(deps: NotificationDeps, claimed: ClaimedNotification): Promise<NotificationOutcome> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const logBase = { notificationId: claimed.id, bookingId: claimed.booking_id, attempt: claimed.attempt_count };

  const suppress = async (reason: string): Promise<NotificationOutcome> => {
    await markTerminal(db, claimed.id, 'suppressed', reason);
    console.log('booking confirmation email suppressed', JSON.stringify({ ...logBase, reason }));
    return { result: 'suppressed', reason };
  };
  const fail = async (reason: string): Promise<NotificationOutcome> => {
    await markTerminal(db, claimed.id, 'failed', reason);
    console.error('booking confirmation email failed', JSON.stringify({ ...logBase, reason, final: true }));
    return { result: 'failed', reason };
  };
  const retryOrFail = async (reason: string): Promise<NotificationOutcome> => {
    if (claimed.attempt_count >= MAX_ATTEMPTS) {
      return fail(`${reason}_retries_exhausted`);
    }
    await markRetry(db, claimed.id, reason, retryDelaySeconds(claimed.attempt_count));
    console.error('booking confirmation email failed', JSON.stringify({ ...logBase, reason, final: false }));
    return { result: 'retry', reason };
  };

  const booking = await loadBookingForNotification(db, claimed.booking_id);
  if (!booking) {
    return fail('booking_not_found');
  }
  if (booking.status !== 'confirmed' || !hasValidAmount(booking.amount_paid_inr)) {
    // E.g. cancelled by an admin after payment. The payment/booking rows are never touched here.
    return suppress('booking_not_confirmed');
  }
  if (booking.scheduled_end_at.getTime() <= now.getTime()) {
    return suppress('booking_in_past');
  }
  if (now.getTime() - claimed.created_at.getTime() > MAX_NOTIFICATION_AGE_MS) {
    return suppress('stale');
  }
  if (booking.booking_environment === 'SANDBOX' && deps.sandboxAllowlist.size === 0) {
    // No Cognito lookup at all when nothing SANDBOX could ever be sent.
    return suppress('sandbox_not_allowlisted');
  }
  if (booking.booking_environment !== 'SANDBOX' && booking.booking_environment !== 'PRODUCTION') {
    return suppress('unknown_environment');
  }

  let resolution: RecipientResolution;
  try {
    resolution = await deps.resolveRecipient(booking.cognito_sub);
  } catch (err) {
    return retryOrFail(`recipient_lookup_${errorName(err)}`);
  }
  if (resolution.kind === 'not_found') {
    return retryOrFail('recipient_not_found');
  }
  if (resolution.kind !== 'verified') {
    return fail('no_verified_recipient');
  }
  const to = resolution.recipient.email;
  if (!isSendable(booking.booking_environment, to, deps.sandboxAllowlist)) {
    return suppress('sandbox_not_allowlisted');
  }

  const details: BookingConfirmationDetails = {
    bookingNumber: booking.booking_number,
    productName: booking.product_name,
    simulatorType: booking.simulator_type,
    racers: booking.racers,
    durationMinutes: booking.duration_minutes,
    scheduledStartAt: booking.scheduled_start_at,
    scheduledEndAt: booking.scheduled_end_at,
    amountPaidInr: booking.amount_paid_inr as string,
  };

  let messageId: string | undefined;
  try {
    messageId = await deps.sender.sendBookingConfirmation(to, details);
  } catch (err) {
    const name = errorName(err);
    return PERMANENT_SEND_ERRORS.has(name) ? fail(`ses_${name}`) : retryOrFail(`ses_${name}`);
  }

  await markSent(db, claimed.id, to, messageId);
  console.log('booking confirmation email sent', JSON.stringify({ ...logBase, environment: booking.booking_environment }));
  return { result: 'sent' };
}

/** Claims and processes due notifications in small batches until none are due or time runs out. */
export async function processDueNotifications(deps: NotificationDeps): Promise<NotificationRunSummary> {
  const summary: NotificationRunSummary = { claimed: 0, sent: 0, suppressed: 0, retried: 0, failed: 0 };
  const hasTimeLeft = deps.hasTimeLeft ?? (() => true);

  while (hasTimeLeft()) {
    let batch: ClaimedNotification[];
    try {
      batch = await claimDueNotifications(deps.db, NOTIFICATION_BATCH_SIZE);
    } catch (err) {
      if (pgCode(err) === '42P01') {
        // undefined_table: abnormal once Stage 2F is active (008 is applied first) — fail loudly.
        throw new NotificationsTableMissingError();
      }
      throw err;
    }
    if (batch.length === 0) {
      break;
    }
    summary.claimed += batch.length;
    for (const claimed of batch) {
      const outcome = await processNotification(deps, claimed);
      if (outcome.result === 'sent') summary.sent += 1;
      else if (outcome.result === 'suppressed') summary.suppressed += 1;
      else if (outcome.result === 'retry') summary.retried += 1;
      else summary.failed += 1;
    }
    if (batch.length < NOTIFICATION_BATCH_SIZE) {
      break;
    }
  }
  return summary;
}

/** Comma-separated emails -> lower-cased set (same shape as PHONEPE_SANDBOX_TESTERS). */
export function parseEmailAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.includes('@')),
  );
}

/** Only the exact string "true" enables sending — same fail-closed convention as the other kill
 *  switches (BOOKING_CREATE_ENABLED, PAYMENT_START_ENABLED). */
export function isConfirmationEmailEnabled(env: Record<string, string | undefined>): boolean {
  return env.BOOKING_CONFIRMATION_EMAIL_ENABLED === 'true';
}

const SAFE_NAME_RE = /^[A-Za-z0-9_]{1,64}$/;

function errorName(err: unknown): string {
  const name = err instanceof Error ? err.name : undefined;
  return name && SAFE_NAME_RE.test(name) ? name : 'unknown';
}

function pgCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}
