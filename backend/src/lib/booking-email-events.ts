// Stage 2G: SES delivery tracking for the booking-confirmation email.
//
// FLOW: booking-notifications.ts sends each confirmation through the SES configuration set
// 'playx-booking-emails' with one message tag, playx_notification_id = booking_notifications.id
// (lib/ses.ts). The configuration set publishes SEND / DELIVERY / DELIVERY_DELAY / BOUNCE /
// COMPLAINT / REJECT / RENDERING_FAILURE events to the EventBridge default bus; a rule on
// source "aws.ses" + those seven detail-types invokes handlers/booking-email-events.ts, which uses
// this module to parse the event and apply it to that one row's delivery columns (migration 009).
//
// EVENT SHAPE (SES event publishing via EventBridge — docs: "Monitoring SES events using Amazon
// EventBridge"; @types/aws-lambda only models SES *receipt* events, so the subset read here is typed
// locally):
//   { "source": "aws.ses", "detail-type": "Email Delivered", "id": "...", "time": "...",
//     "detail": { "eventType": "Delivery",
//                 "mail": { "timestamp", "messageId", "tags": { "<name>": ["<value>"] }, ... },
//                 "delivery": { "timestamp", ... } } }
//   detail-type            detail.eventType     detail sub-object   delivery_status
//   Email Sent             Send                 send                accepted
//   Email Delivered        Delivery             delivery            delivered
//   Email Delivery Delayed DeliveryDelay        deliveryDelay       delayed
//   Email Bounced          Bounce               bounce              bounced
//   Email Complaint Received Complaint          complaint           complained
//   Email Rejected         Reject               reject              rejected
//   Email Rendering Failed Rendering Failure    failure             rendering_failed
//
// CORRELATION: the playx_notification_id tag (a UUID) selects the row by primary key; SES's
// mail.messageId must then equal the row's provider_message_id (recorded when SES accepted the send);
// and mail.tags["ses:configuration-set"] must name our configuration set. The recipient address is
// never used to correlate, never logged and never stored.
//
// EARLY EVENTS: SES can publish an event before the sender has committed status = 'sent' +
// provider_message_id (they are written right after SendEmail returns). A row that exists but is not
// correlation-ready yet (still 'pending', or no provider_message_id) is re-read a couple of times
// within the invocation (CORRELATION_RETRY_DELAYS_MS, ~1.5s in total); if it is still not ready,
// DeliveryCorrelationPendingError is thrown WITHOUT modifying anything, so Lambda's asynchronous
// retry re-delivers the event later instead of it being lost. Unknown ids, other configuration sets,
// malformed tags, 'failed'/'suppressed' rows and message-id mismatches are NOT retried.
//
// STATE MACHINE (forward-only, idempotent — SES/EventBridge deliver best-effort, possibly duplicated
// and out of order):
//   NULL(untracked) / accepted  ->  delayed  ->  delivered  ->  bounced | complained
//                                                 \-> rejected | rendering_failed | bounced | complained
//   rank: accepted 1 < delayed 2 < delivered 3 < {bounced, complained, rejected, rendering_failed} 4.
//   A transition applies only to a strictly higher rank; the rank-4 states are terminal. So a
//   duplicate is a no-op, a late 'delayed' never downgrades 'delivered', and nothing moves a bounce.
//   The UPDATE re-checks the allowed prior states in its WHERE clause, so two concurrent events
//   can never both apply out of order.
//
// ISOLATION: the only statements here are one SELECT and one UPDATE on booking_notifications' Stage
// 2G columns. bookings, payments, booking_allocations and the outbox's own status/retry columns are
// never read or written: an email bounce cannot un-pay, un-confirm or un-allocate anything.
//
// STORED: delivery_status, SES's event timestamps, and a short charset-restricted failure
// type/subtype (bounceType/bounceSubType, complaint feedback type, delay type, 'Reject',
// 'RenderingFailure'). NEVER stored or logged: the raw event, recipients, SMTP responses, diagnostic
// codes, reporting MTAs, rendering error messages or any header.

import type { DbClient } from './allocate-simulators';

/** The SES message tag carrying booking_notifications.id — the ONLY tag lib/ses.ts adds, and the
 *  correlation key here. An internal UUID: never an address, name, phone, Cognito sub or note. */
export const NOTIFICATION_ID_TAG = 'playx_notification_id';

export type DeliveryStatus = 'accepted' | 'delayed' | 'delivered' | 'bounced' | 'complained' | 'rejected' | 'rendering_failed';

interface EventTypeSpec {
  eventType: string;
  status: DeliveryStatus;
}

/** EventBridge detail-type -> the matching detail.eventType and the resulting delivery_status. */
export const SES_EMAIL_EVENT_TYPES: Readonly<Record<string, EventTypeSpec>> = {
  'Email Sent': { eventType: 'Send', status: 'accepted' },
  'Email Delivered': { eventType: 'Delivery', status: 'delivered' },
  'Email Delivery Delayed': { eventType: 'DeliveryDelay', status: 'delayed' },
  'Email Bounced': { eventType: 'Bounce', status: 'bounced' },
  'Email Complaint Received': { eventType: 'Complaint', status: 'complained' },
  'Email Rejected': { eventType: 'Reject', status: 'rejected' },
  'Email Rendering Failed': { eventType: 'Rendering Failure', status: 'rendering_failed' },
};

const RANK: Readonly<Record<DeliveryStatus, number>> = {
  accepted: 1,
  delayed: 2,
  delivered: 3,
  bounced: 4,
  complained: 4,
  rejected: 4,
  rendering_failed: 4,
};

const TERMINAL_RANK = 4;

export const DELIVERY_STATUSES = Object.keys(RANK) as DeliveryStatus[];

/** Whether an event resulting in `next` may be applied to a row currently at `current`. */
export function canTransition(current: DeliveryStatus | null, next: DeliveryStatus): boolean {
  if (current === null) {
    return true;
  }
  if (RANK[current] >= TERMINAL_RANK) {
    return false;
  }
  return RANK[next] > RANK[current];
}

/** The prior states `next` may be applied from (NULL is always allowed) — the UPDATE's guard. */
export function allowedPriorStatuses(next: DeliveryStatus): DeliveryStatus[] {
  return DELIVERY_STATUSES.filter((current) => canTransition(current, next));
}

// ------------------------------------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------------------------------------

export interface ParsedDeliveryEvent {
  /** EventBridge event id (sanitized) — logged for support, never stored. */
  eventId: string | null;
  detailType: string;
  status: DeliveryStatus;
  notificationId: string;
  messageId: string;
  eventAt: Date;
  failureType: string | null;
  failureSubtype: string | null;
}

export type ParseResult =
  | { ok: true; event: ParsedDeliveryEvent }
  | { ok: false; reason: string; detailType: string | null; eventId: string | null };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** SES message ids: hex groups joined by '-' (e.g. 0102018f...-...-000000). */
const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
/** EventBridge event ids are UUIDs; anything else is not logged verbatim. */
const EVENT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** What may be stored as a failure type/subtype (mirrors migration 009's CHECK). */
const SAFE_REASON_RE = /^[A-Za-z0-9 _.-]{1,64}$/;
/** SES event timestamps outside [MIN_TRUSTED, now + MAX_CLOCK_SKEW] are not trusted. */
const MIN_TRUSTED_TIMESTAMP_MS = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 15 * 60_000;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeReason(value: unknown): string | null {
  return typeof value === 'string' && SAFE_REASON_RE.test(value) ? value : null;
}

function trustedTimestamp(value: unknown, now: Date): Date | null {
  if (typeof value !== 'string') {
    return null;
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < MIN_TRUSTED_TIMESTAMP_MS || ms > now.getTime() + MAX_CLOCK_SKEW_MS) {
    return null;
  }
  return new Date(ms);
}

/** The single value of a mail.tags entry, or null if absent, not a string array, or ambiguous. */
function singleTagValue(tags: Json, name: string): string | null {
  const values = tags[name];
  if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === 'string')) {
    return null;
  }
  const distinct = new Set(values as string[]);
  return distinct.size === 1 ? (values[0] as string) : null;
}

interface EventSpecifics {
  timestamp: unknown;
  failureType: string | null;
  failureSubtype: string | null;
}

/** Per-type timestamp + sanitized reason fields. Reads nothing else from the sub-object. */
function specificsFor(status: DeliveryStatus, detail: Json, mail: Json, eventTime: unknown): EventSpecifics {
  const sub = (key: string): Json => (isObject(detail[key]) ? (detail[key] as Json) : {});
  switch (status) {
    case 'accepted':
      return { timestamp: mail.timestamp, failureType: null, failureSubtype: null };
    case 'delivered':
      return { timestamp: sub('delivery').timestamp, failureType: null, failureSubtype: null };
    case 'delayed': {
      const delay = sub('deliveryDelay');
      return { timestamp: delay.timestamp, failureType: 'DeliveryDelay', failureSubtype: safeReason(delay.delayType) };
    }
    case 'bounced': {
      const bounce = sub('bounce');
      return { timestamp: bounce.timestamp, failureType: safeReason(bounce.bounceType) ?? 'Bounce', failureSubtype: safeReason(bounce.bounceSubType) };
    }
    case 'complained': {
      const complaint = sub('complaint');
      return {
        timestamp: complaint.timestamp,
        failureType: 'Complaint',
        failureSubtype: safeReason(complaint.complaintFeedbackType) ?? safeReason(complaint.complaintSubType),
      };
    }
    case 'rejected':
      // reject.reason is SES wording (e.g. "Bad content"); kept only if it passes the charset check.
      return { timestamp: eventTime, failureType: 'Reject', failureSubtype: safeReason(sub('reject').reason) };
    case 'rendering_failed':
      // failure.errorMessage can echo template data — never stored.
      return { timestamp: eventTime, failureType: 'RenderingFailure', failureSubtype: null };
  }
}

/**
 * Validates an EventBridge event and extracts only what delivery tracking needs. Pure: no DB, no
 * logging. `expectedConfigurationSet` must match mail.tags["ses:configuration-set"].
 */
export function parseSesDeliveryEvent(raw: unknown, expectedConfigurationSet: string, now: Date = new Date()): ParseResult {
  if (!isObject(raw)) {
    return { ok: false, reason: 'not_an_object', detailType: null, eventId: null };
  }
  const eventId = typeof raw.id === 'string' && EVENT_ID_RE.test(raw.id) ? raw.id : null;
  const rawDetailType = raw['detail-type'];
  const spec = typeof rawDetailType === 'string' && Object.hasOwn(SES_EMAIL_EVENT_TYPES, rawDetailType) ? SES_EMAIL_EVENT_TYPES[rawDetailType] : undefined;
  const detailType = spec ? (rawDetailType as string) : null;
  const reject = (reason: string): ParseResult => ({ ok: false, reason, detailType, eventId });

  if (raw.source !== 'aws.ses') {
    return reject('wrong_source');
  }
  if (!spec) {
    return reject('unsupported_detail_type');
  }
  const detail = raw.detail;
  if (!isObject(detail)) {
    return reject('missing_detail');
  }
  if (detail.eventType !== spec.eventType) {
    return reject('event_type_mismatch');
  }
  const mail = detail.mail;
  if (!isObject(mail)) {
    return reject('missing_mail');
  }
  if (typeof mail.messageId !== 'string' || !MESSAGE_ID_RE.test(mail.messageId)) {
    return reject('invalid_message_id');
  }
  const tags = isObject(mail.tags) ? mail.tags : {};
  if (singleTagValue(tags, 'ses:configuration-set') !== expectedConfigurationSet) {
    // Another configuration set's mail (or no configuration set): not ours to track.
    return reject('configuration_set_mismatch');
  }
  const notificationId = singleTagValue(tags, NOTIFICATION_ID_TAG);
  if (notificationId === null) {
    return reject('missing_notification_tag');
  }
  if (!UUID_RE.test(notificationId)) {
    return reject('invalid_notification_tag');
  }

  const specifics = specificsFor(spec.status, detail, mail, raw.time);
  const eventAt = trustedTimestamp(specifics.timestamp, now) ?? trustedTimestamp(raw.time, now) ?? now;

  return {
    ok: true,
    event: {
      eventId,
      detailType: detailType as string,
      status: spec.status,
      notificationId: notificationId.toLowerCase(),
      messageId: mail.messageId,
      eventAt,
      failureType: specifics.failureType,
      failureSubtype: specifics.failureSubtype,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Applying
// ------------------------------------------------------------------------------------------------

export type ApplyOutcome =
  /** delivery_status moved forward. */
  | { result: 'applied'; from: DeliveryStatus | null; to: DeliveryStatus }
  /** Duplicate, or out of order behind a later/terminal state — nothing changed. */
  | { result: 'no_change'; current: DeliveryStatus | null; to: DeliveryStatus }
  /** No booking-confirmation row with that id — nothing changed. */
  | { result: 'unknown_notification' }
  /** The row is 'failed' or 'suppressed' — SES never accepted it, so no delivery evidence applies. */
  | { result: 'not_sent' }
  /** SES messageId differs from the row's recorded provider_message_id — nothing changed. */
  | { result: 'message_id_mismatch' };

interface NotificationDeliveryRow {
  id: string;
  status: string;
  provider_message_id: string | null;
  delivery_status: DeliveryStatus | null;
}

/** Delays before the 2nd and 3rd read of a row that is not correlation-ready yet (1.5s total). */
export const CORRELATION_RETRY_DELAYS_MS: readonly number[] = [500, 1000];

/**
 * The event's row exists but the sender has not recorded SES's acceptance yet, even after the bounded
 * re-reads. Thrown so Lambda's asynchronous retry re-delivers the event; nothing was modified. The
 * message carries no identifiers.
 */
export class DeliveryCorrelationPendingError extends Error {
  constructor() {
    super('booking notification not yet recorded as sent; event will be retried');
    this.name = 'DeliveryCorrelationPendingError';
  }
}

export interface ApplyOptions {
  /** Injectable for tests; defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Still being written by the sender: 'pending', or 'sent' without its provider_message_id. */
function isAwaitingSendRecord(row: NotificationDeliveryRow): boolean {
  return row.status === 'pending' || (row.status === 'sent' && row.provider_message_id === null);
}

async function readRow(db: DbClient, notificationId: string): Promise<NotificationDeliveryRow | undefined> {
  const { rows } = await db.query<NotificationDeliveryRow>(
    `SELECT id, status, provider_message_id, delivery_status
     FROM booking_notifications
     WHERE id = $1 AND notification_type = 'BOOKING_CONFIRMED'`,
    [notificationId],
  );
  return rows[0];
}

/**
 * Applies one parsed event to its row. Throws DeliveryCorrelationPendingError (retriable, nothing
 * modified) for a row the sender has not finished recording; otherwise only DB errors throw.
 */
export async function applyDeliveryEvent(db: DbClient, event: ParsedDeliveryEvent, options: ApplyOptions = {}): Promise<ApplyOutcome> {
  const sleep = options.sleep ?? defaultSleep;
  const delays = options.retryDelaysMs ?? CORRELATION_RETRY_DELAYS_MS;

  let row = await readRow(db, event.notificationId);
  for (const delay of delays) {
    if (!row || !isAwaitingSendRecord(row)) {
      break;
    }
    await sleep(delay);
    row = await readRow(db, event.notificationId);
  }
  if (!row) {
    return { result: 'unknown_notification' };
  }
  if (isAwaitingSendRecord(row)) {
    throw new DeliveryCorrelationPendingError();
  }
  if (row.status !== 'sent') {
    return { result: 'not_sent' };
  }
  if (row.provider_message_id !== event.messageId) {
    return { result: 'message_id_mismatch' };
  }
  if (!canTransition(row.delivery_status, event.status)) {
    return { result: 'no_change', current: row.delivery_status, to: event.status };
  }

  // The WHERE clause repeats every check above, so a concurrent event that got there first (or a
  // row that changed since the SELECT) makes this a no-op instead of a downgrade.
  const { rows: updated } = await db.query<{ delivery_status: DeliveryStatus }>(
    `UPDATE booking_notifications
     SET delivery_status = $2,
         last_delivery_event_at = $3::timestamptz,
         delivered_at = CASE WHEN $2::text = 'delivered' THEN COALESCE(delivered_at, $3::timestamptz) ELSE delivered_at END,
         bounced_at = CASE WHEN $2::text = 'bounced' THEN COALESCE(bounced_at, $3::timestamptz) ELSE bounced_at END,
         complained_at = CASE WHEN $2::text = 'complained' THEN COALESCE(complained_at, $3::timestamptz) ELSE complained_at END,
         delivery_failure_type = CASE WHEN $2::text IN ('accepted', 'delivered') THEN NULL ELSE $4::text END,
         delivery_failure_subtype = CASE WHEN $2::text IN ('accepted', 'delivered') THEN NULL ELSE $5::text END,
         updated_at = now()
     WHERE id = $1 AND notification_type = 'BOOKING_CONFIRMED' AND status = 'sent'
       AND provider_message_id = $6
       AND (delivery_status IS NULL OR delivery_status = ANY($7::text[]))
     RETURNING delivery_status`,
    [
      event.notificationId,
      event.status,
      event.eventAt,
      event.failureType,
      event.failureSubtype,
      event.messageId,
      allowedPriorStatuses(event.status),
    ],
  );
  if (updated.length === 0) {
    return { result: 'no_change', current: row.delivery_status, to: event.status };
  }
  return { result: 'applied', from: row.delivery_status, to: event.status };
}
