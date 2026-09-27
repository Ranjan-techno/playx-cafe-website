import type { Context } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import {
  isConfirmationEmailEnabled,
  parseEmailAllowlist,
  processDueNotifications,
  resolveDeliveryTrackingConfigurationSet,
  type BookingConfirmationDetails,
  type NotificationDeps,
  type NotificationRunSummary,
} from '../lib/booking-notifications';
import { resolveVerifiedAccountEmail } from '../lib/verified-account-email';
import { getDb, resetDb } from '../lib/db';
import { sendBookingConfirmationEmail } from '../lib/ses';

// Stage 2F: playx-dev-booking-confirmation-notify — the scheduled (EventBridge, every minute) sender
// of the transactional booking-confirmation email. Not an HTTP route; the event is ignored. See
// lib/booking-notifications.ts for the outbox, claim/lease, idempotency and retry model.
//
// The ONLY Lambda with ses:SendEmail for booking emails (sender pinned by ses:FromAddress) and with
// cognito-idp:AdminGetUser for recipient lookup. The payment Lambdas that confirm bookings only write
// the outbox row — they get no SES or Cognito permission.
//
// SWITCHES (Lambda environment, set in infra):
//   BOOKING_CONFIRMATION_EMAIL_ENABLED  exactly "true" to send; anything else -> the run does nothing
//                                       (pending rows wait; stale/past ones are suppressed later).
//   BOOKING_EMAIL_SANDBOX_ALLOWLIST     comma-separated emails SANDBOX (staging) confirmations may go
//                                       to. Empty (the default) -> every SANDBOX email is suppressed,
//                                       so staging never emails real customers.
//   BOOKING_EMAIL_DELIVERY_TRACKING_ENABLED  Stage 2G: exactly "true" -> send through the SES
//                                       configuration set SES_CONFIGURATION_SET with the
//                                       playx_notification_id tag, and record delivery_status =
//                                       'accepted'. "true" with no valid SES_CONFIGURATION_SET FAILS
//                                       CLOSED: the run throws before claiming anything (alarm).
//
// ERRORS: transient send/lookup failures are recorded on the row and retried by later runs — they do
// not fail the invocation. The invocation THROWS (-> Lambda Errors -> alarm) only for a notification
// that reached 'failed' in this run, or an unexpected failure (DB, configuration, or a missing
// booking_notifications table — migration 008 must be applied before this Lambda is deployed).
//
// Logs: run summary counts, notification/booking ids and reason codes. Never recipient addresses,
// email bodies, tokens or credentials.

/** Sends one confirmation; `tracking` is undefined when delivery tracking is off. */
export type ConfirmationEmailSend = (
  to: string,
  details: BookingConfirmationDetails,
  tracking: { configurationSetName: string; notificationId: string } | undefined,
) => Promise<string | undefined>;

export interface NotifyHandlerDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  resolveRecipient: NotificationDeps['resolveRecipient'];
  send: ConfirmationEmailSend;
  env: Record<string, string | undefined>;
  now?: () => Date;
}

const defaultDeps: NotifyHandlerDeps = {
  getDb,
  resetDb,
  resolveRecipient: (cognitoSub) => resolveVerifiedAccountEmail(cognitoSub),
  send: sendBookingConfirmationEmail,
  env: process.env,
};

/** Stop claiming new batches when this little time remains (one lookup + one send per row). */
const SAFETY_MARGIN_MS = 15_000;

const LOG = 'booking-confirmation-notify';

export class NotificationDeliveryFailedError extends Error {
  constructor(count: number) {
    super(`${count} booking confirmation notification(s) failed permanently`);
    this.name = 'NotificationDeliveryFailedError';
  }
}

export function createHandler(deps: NotifyHandlerDeps = defaultDeps) {
  return async (_event: unknown, context?: Pick<Context, 'getRemainingTimeInMillis'>): Promise<NotificationRunSummary | { disabled: true }> => {
    if (!isConfirmationEmailEnabled(deps.env)) {
      console.log(`${LOG} run`, JSON.stringify({ disabled: true }));
      return { disabled: true };
    }

    let configurationSetName: string | null;
    try {
      configurationSetName = resolveDeliveryTrackingConfigurationSet(deps.env);
    } catch (err) {
      // Fail closed before claiming anything: the rows wait as 'pending' and the Errors alarm fires.
      console.error(`${LOG} failed`, JSON.stringify({ error: err instanceof Error ? err.name : 'unknown' }));
      throw err;
    }
    const sender: NotificationDeps['sender'] = {
      sendBookingConfirmation: (to, details, { notificationId }) =>
        deps.send(to, details, configurationSetName ? { configurationSetName, notificationId } : undefined),
    };

    let summary: NotificationRunSummary;
    try {
      const db = await deps.getDb();
      summary = await processDueNotifications({
        db,
        resolveRecipient: deps.resolveRecipient,
        sender,
        deliveryTracking: configurationSetName !== null,
        sandboxAllowlist: parseEmailAllowlist(deps.env.BOOKING_EMAIL_SANDBOX_ALLOWLIST),
        now: deps.now,
        hasTimeLeft: context ? () => context.getRemainingTimeInMillis() > SAFETY_MARGIN_MS : undefined,
      });
    } catch (err) {
      deps.resetDb();
      console.error(`${LOG} failed`, JSON.stringify({ error: err instanceof Error ? err.name : 'unknown' }));
      throw err;
    }

    console.log(`${LOG} run`, JSON.stringify(summary));
    if (summary.failed > 0) {
      // Every outcome is already recorded; throwing only surfaces the permanent failure(s) to the
      // Errors alarm. EventBridge retryAttempts is 0, so nothing is re-run because of it.
      throw new NotificationDeliveryFailedError(summary.failed);
    }
    return summary;
  };
}

export const handler = createHandler();
