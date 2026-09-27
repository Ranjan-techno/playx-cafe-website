import type { DbClient } from '../lib/allocate-simulators';
import {
  applyDeliveryEvent,
  DeliveryCorrelationPendingError,
  parseSesDeliveryEvent,
  type ApplyOutcome,
} from '../lib/booking-email-events';
import { getDb, resetDb } from '../lib/db';

// Stage 2G: playx-dev-booking-email-events — applies SES delivery events for booking-confirmation
// emails to booking_notifications' delivery columns (migration 009). Invoked ONLY by the EventBridge
// rule in infra/lib/constructs/notifications.ts (source "aws.ses" + the seven email detail-types SES
// publishes from the 'playx-booking-emails' configuration set). Not an HTTP route. See
// lib/booking-email-events.ts for the event shape, correlation and forward-only state machine.
//
// OPERATIONAL ONLY: never reads or writes bookings, payments, booking_allocations or the outbox's
// status/retry columns. Permissions (infra): VPC/DB connectivity, the DB secret, CloudWatch Logs —
// no SES, Cognito, PhonePe or SQS.
//
// ERRORS: a malformed, foreign (other configuration set / no tag), unknown, mismatched or
// out-of-order event is logged and ignored — never thrown, so it neither retries nor alarms. The
// invocation THROWS only for (a) an event that arrived before the sender recorded the send
// (DeliveryCorrelationPendingError, after bounded in-invocation re-reads), (b) a DB failure, or (c)
// missing configuration. EventBridge invokes this function ASYNCHRONOUSLY, so a thrown error is
// retried by Lambda's async-invoke configuration (infra: 2 retries, max event age 6h) and counted in
// the Lambda Errors metric (alarm). Retrying is safe: every transition is idempotent.
//
// LOGS: outcome, the known detail-type, the notification id (internal UUID), the EventBridge event id
// and the from/to delivery status. Never the raw event, recipients, sender, subject, SMTP response,
// SES message id or any header.

export interface EmailEventsHandlerDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  env: Record<string, string | undefined>;
  now?: () => Date;
  /** Delay between correlation re-reads — injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultDeps: EmailEventsHandlerDeps = { getDb, resetDb, env: process.env };

const LOG = 'booking-email-events';
const CONFIGURATION_SET_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export class EmailEventsMisconfiguredError extends Error {
  constructor() {
    super('SES_CONFIGURATION_SET is missing or invalid');
    this.name = 'EmailEventsMisconfiguredError';
  }
}

export type EmailEventsResult =
  | { result: 'ignored'; reason: string }
  | ApplyOutcome;

export function createHandler(deps: EmailEventsHandlerDeps = defaultDeps) {
  return async (event: unknown): Promise<EmailEventsResult> => {
    const configurationSet = deps.env.SES_CONFIGURATION_SET;
    if (!configurationSet || !CONFIGURATION_SET_NAME_RE.test(configurationSet)) {
      console.error(`${LOG} failed`, JSON.stringify({ error: 'EmailEventsMisconfiguredError' }));
      throw new EmailEventsMisconfiguredError();
    }

    const now = (deps.now ?? (() => new Date()))();
    const parsed = parseSesDeliveryEvent(event, configurationSet, now);
    if (!parsed.ok) {
      // No DB access at all for an event that is not ours or not well-formed.
      console.warn(
        `${LOG} ignored`,
        JSON.stringify({ reason: parsed.reason, detailType: parsed.detailType ?? 'other', eventId: parsed.eventId }),
      );
      return { result: 'ignored', reason: parsed.reason };
    }

    const { event: parsedEvent } = parsed;
    let outcome: ApplyOutcome;
    try {
      const db = await deps.getDb();
      outcome = await applyDeliveryEvent(db, parsedEvent, { sleep: deps.sleep });
    } catch (err) {
      if (err instanceof DeliveryCorrelationPendingError) {
        // Not a DB problem: keep the connection. Nothing was modified; Lambda retries the event.
        console.warn(
          `${LOG} retry`,
          JSON.stringify({ reason: 'send_not_recorded_yet', detailType: parsedEvent.detailType, notificationId: parsedEvent.notificationId, eventId: parsedEvent.eventId }),
        );
        throw err;
      }
      deps.resetDb();
      console.error(
        `${LOG} failed`,
        JSON.stringify({ error: err instanceof Error ? err.name : 'unknown', notificationId: parsedEvent.notificationId, eventId: parsedEvent.eventId }),
      );
      throw err;
    }

    const logFields = {
      ...outcome,
      detailType: parsedEvent.detailType,
      notificationId: parsedEvent.notificationId,
      eventId: parsedEvent.eventId,
    };
    if (outcome.result === 'applied' || outcome.result === 'no_change') {
      console.log(`${LOG} ${outcome.result}`, JSON.stringify(logFields));
    } else {
      // Tagged as ours but not matching a sent row — worth a look, but never a reason to modify or retry.
      console.warn(`${LOG} ignored`, JSON.stringify(logFields));
    }
    return outcome;
  };
}

export const handler = createHandler();
