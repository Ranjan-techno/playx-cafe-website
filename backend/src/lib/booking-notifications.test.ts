import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import type { DbClient } from './allocate-simulators';
import {
  CLAIM_LEASE_SECONDS,
  MAX_ATTEMPTS,
  NotificationsTableMissingError,
  enqueueBookingConfirmedNotification,
  parseEmailAllowlist,
  processDueNotifications,
  retryDelaySeconds,
  type BookingConfirmationDetails,
  type NotificationDeps,
  type RecipientResolution,
} from './booking-notifications';
import { confirmSuccessfulPayment } from './confirm-successful-payment';
import { fastReconcilePayment } from './fast-reconcile-payment';
import { createPaymentAttempt } from './payment-repository';
import { processProductionPaymentCallback } from './production-payment-webhook';
import { reconcilePayment } from './reconcile-payment';
import { reconcilePendingPayments } from './reconcile-pending-payments';
import { startPayment } from './start-payment';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  seedBooking,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';
import { FakeReconcileQueue } from './test-support/fake-reconcile-queue';
import { ScriptedProvider } from './test-support/scripted-provider';
import { createHandler as createStatusHandler } from '../handlers/payment-status';
import { getCognitoClient } from './cognito';
import { resolveVerifiedAccountEmail } from './verified-account-email';
import { createHandler as createNotifyHandler, NotificationDeliveryFailedError } from '../handlers/booking-confirmation-notify';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Stage 2F: the booking-confirmation email, end to end against the in-memory fake DB — the REAL
// confirmSuccessfulPayment() and the REAL webhook / status-poll / fast-SQS / scheduled reconciliation
// paths that call it, then the REAL sender. Only PhonePe (ScriptedProvider), Cognito (resolver) and
// SES (sender) are stand-ins.

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const SUB = '3b994cfd-0b07-4581-be46-3c82f9a70c90';
const CUSTOMER_EMAIL = 'racer@example.com';

afterEach(() => mock.timers.reset());

function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

interface SentEmail {
  to: string;
  details: BookingConfirmationDetails;
  /** Snapshot at the moment of sending — proves the send happens after the confirmation committed. */
  paymentStatus: string;
  bookingStatus: string;
  anyTransactionOpen: boolean;
}

interface World {
  store: FakePaymentDbStore;
  db: ReturnType<typeof createFakePaymentDbClient>;
  provider: ScriptedProvider;
  bookingId: string;
  paymentId: string;
  orderId: string;
  sent: SentEmail[];
  lookups: string[];
  sendError?: (attempt: number) => Error | undefined;
  resolution: RecipientResolution | Error;
  notifyDeps: (overrides?: Partial<NotificationDeps>) => NotificationDeps;
}

/** A PRODUCTION (default) booking with one open PhonePe attempt started through startPayment(). */
async function world(opts: { environment?: 'SANDBOX' | 'PRODUCTION'; price?: string } = {}): Promise<World> {
  clockAt(T0);
  const environment = opts.environment ?? 'PRODUCTION';
  const price = opts.price ?? '399.00';
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    id: randomUUID(),
    priceInr: price,
    holdExpiresAt: new Date(T0 + 15 * MIN),
    start: new Date(T0 + 24 * 60 * MIN),
    simulatorIds: ['sim-S1'],
    cognitoSub: SUB,
    bookingNumber: 1040,
    productName: 'Solo Pro — Static',
    bookingEnvironment: environment,
  });
  const db = createFakePaymentDbClient(store);
  const provider = new ScriptedProvider();
  provider.environment = environment;
  const started = await startPayment(db, provider, {
    bookingId: booking.id,
    environment,
    checkoutHoldMinutes: 20,
    description: 'Solo Pro — Static',
  });
  provider.createCalls = [];
  const orderId = store.payments.find((p) => p.id === started.paymentId)!.provider_order_id;

  const w: World = {
    store,
    db,
    provider,
    bookingId: booking.id,
    paymentId: started.paymentId,
    orderId,
    sent: [],
    lookups: [],
    resolution: { kind: 'verified', recipient: { email: CUSTOMER_EMAIL } },
    notifyDeps: (overrides = {}) => ({
      db: createFakePaymentDbClient(store),
      resolveRecipient: async (sub) => {
        w.lookups.push(sub);
        if (w.resolution instanceof Error) throw w.resolution;
        return w.resolution;
      },
      sender: {
        sendBookingConfirmation: async (to, details) => {
          const failure = w.sendError?.(w.sent.length);
          if (failure) throw failure;
          const payment = store.payments.find((p) => p.id === w.paymentId)!;
          const b = store.bookings.find((x) => x.id === w.bookingId)!;
          w.sent.push({ to, details, paymentStatus: payment.payment_status, bookingStatus: b.status, anyTransactionOpen: db.inTransaction() });
          return `ses-msg-${w.sent.length}`;
        },
      },
      sandboxAllowlist: new Set(),
      ...overrides,
    }),
  };
  return w;
}

const success = (w: World) => ({ outcome: 'SUCCESS' as const, amountInr: '399.00', currency: 'INR', providerTransactionId: 'TX-1' });
const paymentOf = (w: World) => w.store.payments.find((p) => p.id === w.paymentId)!;
const bookingOf = (w: World) => w.store.bookings.find((b) => b.id === w.bookingId)!;
const notificationsOf = (w: World) => w.store.notifications.filter((n) => n.booking_id === w.bookingId);
const webhook = (w: World) => processProductionPaymentCallback({ db: createFakePaymentDbClient(w.store), getProvider: async () => w.provider as never }, w.orderId);
const snapshot = (w: World) => JSON.stringify({ payment: paymentOf(w), booking: bookingOf(w), allocations: w.store.allocations });

async function confirmViaWebhook(w: World): Promise<void> {
  w.provider.statuses.set(w.orderId, success(w));
  const outcome = await webhook(w);
  assert.equal(outcome.result, 'confirmed');
}

function statusEvent(bookingId: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    pathParameters: { bookingId },
    requestContext: { authorizer: { jwt: { claims: { sub: SUB }, scopes: [] } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

// ------------------------------------------------------------------ trigger

test('pending payment: a PENDING provider outcome creates no notification', async () => {
  const w = await world();
  w.provider.statuses.set(w.orderId, { outcome: 'PENDING' });
  assert.equal((await webhook(w)).result, 'pending');
  assert.equal(notificationsOf(w).length, 0);
  assert.equal((await processDueNotifications(w.notifyDeps())).claimed, 0);
  assert.equal(w.sent.length, 0);
});

test('failed payment: a FAILED provider outcome creates no notification', async () => {
  const w = await world();
  w.provider.statuses.set(w.orderId, { outcome: 'FAILED', failureReason: 'declined' });
  assert.equal((await webhook(w)).result, 'failed');
  assert.equal(paymentOf(w).payment_status, 'failed');
  assert.equal(notificationsOf(w).length, 0);
});

test('authoritative success: the confirmation commits ONE pending BOOKING_CONFIRMED row and sends nothing itself', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  assert.equal(paymentOf(w).payment_status, 'paid');
  assert.equal(bookingOf(w).status, 'confirmed');
  const rows = notificationsOf(w);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].notification_type, 'BOOKING_CONFIRMED');
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].attempt_count, 0);
  assert.equal(rows[0].recipient_email, null, 'no recipient is taken from the payment path');
  assert.equal(w.sent.length, 0, 'confirmation never emails — the sender does, later');
});

test('confirmSuccessfulPayment reports the enqueue; an alreadyConfirmed replay enqueues nothing', async () => {
  const w = await world();
  const first = await confirmSuccessfulPayment(w.db, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  assert.equal(first.confirmationNotification, 'queued');
  const replay = await confirmSuccessfulPayment(w.db, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  assert.equal(replay.alreadyConfirmed, true);
  assert.equal(replay.confirmationNotification, undefined);
  assert.equal(notificationsOf(w).length, 1);
});

test('email happens after the confirmation path: the sender only ever sees a committed PAID + CONFIRMED booking', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const summary = await processDueNotifications(w.notifyDeps());
  assert.deepEqual(summary, { claimed: 1, sent: 1, suppressed: 0, retried: 0, failed: 0 });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].paymentStatus, 'paid');
  assert.equal(w.sent[0].bookingStatus, 'confirmed');
  assert.equal(w.sent[0].anyTransactionOpen, false);
  assert.equal(w.sent[0].to, CUSTOMER_EMAIL);
  assert.deepEqual(w.lookups, [SUB], 'recipient resolved from the booking owner, server-side');
  const row = notificationsOf(w)[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.recipient_email, CUSTOMER_EMAIL);
  assert.equal(row.provider_message_id, 'ses-msg-1');
  assert.ok(row.sent_at instanceof Date);
  assert.equal(w.sent[0].details.bookingNumber, 1040);
  assert.equal(w.sent[0].details.amountPaidInr, '399.00', 'amount comes from the PAID payment row');
});

test('a paid booking that cannot be confirmed (refund_required) gets no confirmation email', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', status: 'cancelled', holdAllocations: 0, cognitoSub: SUB });
  const db = createFakePaymentDbClient(store);
  const payment = await createPaymentAttempt(db, { paymentEnvironment: 'PRODUCTION', bookingId: booking.id, provider: 'mock', providerOrderId: 'o-c', amountInr: '399.00' });
  const result = await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: payment.provider_order_id, amountInr: '399.00' });
  assert.equal(result.outcome, 'refund_required');
  assert.equal(store.notifications.length, 0);
});

test('a second collected payment for an already-confirmed booking adds no second notification', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', cognitoSub: SUB });
  const db = createFakePaymentDbClient(store);
  const a = await createPaymentAttempt(db, { paymentEnvironment: 'PRODUCTION', bookingId: booking.id, provider: 'mock', providerOrderId: 'o-a', amountInr: '399.00' });
  const b = await createPaymentAttempt(db, { paymentEnvironment: 'PRODUCTION', bookingId: booking.id, provider: 'mock', providerOrderId: 'o-b', amountInr: '399.00' });
  await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: a.provider_order_id, amountInr: '399.00' });
  const second = await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: b.provider_order_id, amountInr: '399.00' });
  assert.equal(second.outcome, 'refund_required');
  assert.equal(store.notifications.length, 1);
});

test('an admin-confirmed booking that is then paid gets exactly one notification', async () => {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, { priceInr: '399.00', status: 'confirmed', allocationStatus: 'confirmed', cognitoSub: SUB });
  const db = createFakePaymentDbClient(store);
  const p = await createPaymentAttempt(db, { paymentEnvironment: 'PRODUCTION', bookingId: booking.id, provider: 'mock', providerOrderId: 'o-adm', amountInr: '399.00' });
  const result = await confirmSuccessfulPayment(db, { provider: 'mock', providerOrderId: p.provider_order_id, amountInr: '399.00' });
  assert.equal(result.confirmationNotification, 'queued');
  assert.equal(store.notifications.length, 1);
});

// ------------------------------------------------------------------ idempotency across paths

test('duplicate successful webhook: no second notification, one email', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  assert.equal((await webhook(w)).result, 'already_final');
  assert.equal(notificationsOf(w).length, 1);
  await processDueNotifications(w.notifyDeps());
  assert.equal((await webhook(w)).result, 'already_final');
  await processDueNotifications(w.notifyDeps());
  assert.equal(w.sent.length, 1);
});

test('status polling after the webhook: no second notification', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const status = createStatusHandler(
    { getDb: async () => createFakePaymentDbClient(w.store), resetDb: () => {}, getProvider: async () => w.provider as never },
    { environment: 'PRODUCTION' },
  );
  for (let i = 0; i < 3; i += 1) {
    const res = (await status(statusEvent(w.bookingId))) as { statusCode: number; body: string };
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).outcome, 'confirmed');
  }
  // Even a direct reconcile (what an open-attempt poll does) finds the payment already paid.
  await reconcilePayment(createFakePaymentDbClient(w.store), w.provider, w.orderId);
  assert.equal(notificationsOf(w).length, 1);
  await processDueNotifications(w.notifyDeps());
  assert.equal(w.sent.length, 1);
});

test('fast SQS reconciliation after the webhook: no second notification', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const queue = new FakeReconcileQueue();
  const result = await fastReconcilePayment(
    { db: createFakePaymentDbClient(w.store), queue, getProvider: async () => w.provider as never },
    { paymentId: w.paymentId, seq: 1 },
  );
  assert.notEqual(result.result, 'confirmed');
  assert.equal(notificationsOf(w).length, 1);
});

test('scheduled fallback reconciliation after the webhook: no second notification', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const summary = await reconcilePendingPayments(createFakePaymentDbClient(w.store), w.provider as never, 'PRODUCTION');
  assert.equal(summary.processed, 0);
  assert.equal(notificationsOf(w).length, 1);
});

test('fast reconciliation confirms first, then a late webhook: still one notification, one email', async () => {
  const w = await world();
  w.provider.statuses.set(w.orderId, success(w));
  await fastReconcilePayment(
    { db: createFakePaymentDbClient(w.store), queue: new FakeReconcileQueue(), getProvider: async () => w.provider as never },
    { paymentId: w.paymentId, seq: 1 },
  );
  assert.equal(bookingOf(w).status, 'confirmed');
  assert.equal((await webhook(w)).result, 'already_final');
  await processDueNotifications(w.notifyDeps());
  await processDueNotifications(w.notifyDeps());
  assert.equal(notificationsOf(w).length, 1);
  assert.equal(w.sent.length, 1);
});

test('concurrent webhook + status reconcile + scheduled reconcile racing on the same success: one notification', async () => {
  const w = await world();
  w.provider.statuses.set(w.orderId, success(w));
  await Promise.all([
    webhook(w),
    reconcilePayment(createFakePaymentDbClient(w.store), w.provider, w.orderId),
    reconcilePendingPayments(createFakePaymentDbClient(w.store), w.provider as never, 'PRODUCTION'),
  ]);
  assert.equal(paymentOf(w).payment_status, 'paid');
  assert.equal(notificationsOf(w).length, 1);
});

test('the outbox insert itself is idempotent (UNIQUE booking_id + type)', async () => {
  const w = await world();
  await w.db.query('BEGIN');
  assert.equal(await enqueueBookingConfirmedNotification(w.db, w.bookingId), 'queued');
  assert.equal(await enqueueBookingConfirmedNotification(w.db, w.bookingId), 'already_queued');
  await w.db.query('COMMIT');
  assert.equal(notificationsOf(w).length, 1);
});

test('duplicate / overlapping sender runs: exactly one email', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slowDeps = w.notifyDeps();
  const inner = slowDeps.sender.sendBookingConfirmation;
  slowDeps.sender = {
    sendBookingConfirmation: async (to, details) => {
      await gate;
      return inner(to, details);
    },
  };
  const runA = processDueNotifications(slowDeps);
  await new Promise((r) => setImmediate(r));
  const runB = await processDueNotifications(w.notifyDeps()); // row is leased by run A
  assert.equal(runB.claimed, 0);
  release();
  assert.equal((await runA).sent, 1);
  // Past the lease: the row is 'sent', so nothing is re-claimed.
  clockAt(T0 + (CLAIM_LEASE_SECONDS + 60) * 1000);
  assert.equal((await processDueNotifications(w.notifyDeps())).claimed, 0);
  assert.equal(w.sent.length, 1);
});

test('existing confirmed bookings (no outbox row, e.g. #1033) are never emailed — not even on a replayed success', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  w.store.notifications.length = 0; // model a booking confirmed before Stage 2F / migration 008
  await confirmSuccessfulPayment(w.db, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  await webhook(w);
  assert.equal((await processDueNotifications(w.notifyDeps())).claimed, 0);
  assert.equal(w.sent.length, 0);
});

// ------------------------------------------------------------------ failure / retry

test('SES failure: PAID and CONFIRMED untouched; the row stays pending and retryable with backoff', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const before = snapshot(w);
  w.sendError = () => Object.assign(new Error('throttled'), { name: 'Throttling' });
  const summary = await processDueNotifications(w.notifyDeps());
  assert.deepEqual(summary, { claimed: 1, sent: 0, suppressed: 0, retried: 1, failed: 0 });
  assert.equal(snapshot(w), before, 'payment, booking and allocations are byte-for-byte unchanged');
  const row = notificationsOf(w)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.attempt_count, 1);
  assert.equal(row.last_error, 'ses_Throttling');
  assert.equal(row.next_attempt_at.getTime(), T0 + retryDelaySeconds(1) * 1000);

  // Not due yet -> nothing claimed; once due, a healthy SES sends it exactly once.
  assert.equal((await processDueNotifications(w.notifyDeps())).claimed, 0);
  w.sendError = undefined;
  clockAt(T0 + retryDelaySeconds(1) * 1000);
  assert.equal((await processDueNotifications(w.notifyDeps())).sent, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(notificationsOf(w)[0].status, 'sent');
  assert.equal(snapshot(w), before);
});

test('retries exhausted: the row becomes failed, the handler throws for the alarm, payment/booking still PAID/CONFIRMED', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const before = snapshot(w);
  w.sendError = () => Object.assign(new Error('down'), { name: 'ServiceUnavailable' });
  let now = T0;
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    assert.equal((await processDueNotifications(w.notifyDeps())).retried, 1);
    now += retryDelaySeconds(i) * 1000;
    clockAt(now);
  }
  const handler = createNotifyHandler({
    getDb: async () => createFakePaymentDbClient(w.store),
    resetDb: () => {},
    resolveRecipient: w.notifyDeps().resolveRecipient,
    sender: w.notifyDeps().sender,
    env: { BOOKING_CONFIRMATION_EMAIL_ENABLED: 'true' },
  });
  await assert.rejects(handler({}), NotificationDeliveryFailedError);
  const row = notificationsOf(w)[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.attempt_count, MAX_ATTEMPTS);
  assert.equal(row.last_error, 'ses_ServiceUnavailable_retries_exhausted');
  assert.equal(snapshot(w), before);
  assert.equal(paymentOf(w).payment_status, 'paid');
  assert.equal(bookingOf(w).status, 'confirmed');
});

test('a permanent SES rejection fails immediately without retries', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  w.sendError = () => Object.assign(new Error('rejected'), { name: 'MessageRejected' });
  assert.equal((await processDueNotifications(w.notifyDeps())).failed, 1);
  assert.equal(notificationsOf(w)[0].status, 'failed');
  assert.equal(notificationsOf(w)[0].last_error, 'ses_MessageRejected');
});

test('outbox insert failure (table unexpectedly missing) never fails the confirmation; the sender fails loudly', async () => {
  const w = await world();
  w.store.notificationsTableMissing = true;
  w.provider.statuses.set(w.orderId, success(w));
  assert.equal((await webhook(w)).result, 'confirmed');
  assert.equal(paymentOf(w).payment_status, 'paid');
  assert.equal(bookingOf(w).status, 'confirmed');
  assert.equal(w.store.allocations.find((a) => a.booking_id === w.bookingId)!.allocation_status, 'confirmed');
  assert.equal(w.store.notifications.length, 0);
  // ...but the sender treats the missing table as abnormal (migration 008 ships first): it throws,
  // so the handler's invocation fails and the Errors alarm fires.
  await assert.rejects(processDueNotifications(w.notifyDeps()), NotificationsTableMissingError);
  const handler = createNotifyHandler({
    getDb: async () => createFakePaymentDbClient(w.store),
    resetDb: () => {},
    resolveRecipient: w.notifyDeps().resolveRecipient,
    sender: w.notifyDeps().sender,
    env: { BOOKING_CONFIRMATION_EMAIL_ENABLED: 'true' },
  });
  await assert.rejects(handler({}), NotificationsTableMissingError);
  assert.equal(w.sent.length, 0);
});

test('the outbox ON CONFLICT target matches migration 008\'s unique constraint', () => {
  const root = path.join(__dirname, '../../..');
  const migration = readFileSync(path.join(root, 'database/migrations/008_booking_notifications.sql'), 'utf8');
  assert.match(migration, /CONSTRAINT booking_notifications_booking_type_unique UNIQUE \(booking_id, notification_type\)/);
  const lib = readFileSync(path.join(root, 'backend/src/lib/booking-notifications.ts'), 'utf8');
  assert.match(lib, /ON CONFLICT \(booking_id, notification_type\) DO NOTHING/);
});

test('outbox insert failure rolls back only its savepoint; the confirmation result says not_queued', async () => {
  const w = await world();
  const failingInsert: DbClient = {
    query: async (text, params) => {
      if (/^INSERT INTO booking_notifications/i.test(text.trim())) throw Object.assign(new Error('boom'), { code: '23514' });
      return w.db.query(text, params);
    },
  };
  const result = await confirmSuccessfulPayment(failingInsert, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  assert.equal(result.confirmationNotification, 'not_queued');
  assert.equal(paymentOf(w).payment_status, 'paid');
  assert.equal(bookingOf(w).status, 'confirmed');
});

test('a confirmation that rolls back leaves no notification row behind', async () => {
  const w = await world();
  const commitFails: DbClient = {
    query: async (text, params) => {
      if (/^COMMIT/i.test(text.trim())) throw new Error('connection lost at commit');
      return w.db.query(text, params);
    },
  };
  await assert.rejects(confirmSuccessfulPayment(commitFails, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' }));
  assert.notEqual(paymentOf(w).payment_status, 'paid');
  assert.equal(bookingOf(w).status, 'pending');
  assert.equal(w.store.notifications.length, 0, 'the outbox row rolled back with the confirmation');
});

// ------------------------------------------------------------------ recipient / suppression

test('recipient lookup failure is retried; an account without a verified email fails without sending', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  w.resolution = Object.assign(new Error('x'), { name: 'TooManyRequestsException' });
  assert.equal((await processDueNotifications(w.notifyDeps())).retried, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'recipient_lookup_TooManyRequestsException');

  clockAt(T0 + retryDelaySeconds(1) * 1000);
  w.resolution = { kind: 'unavailable' };
  assert.equal((await processDueNotifications(w.notifyDeps())).failed, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'no_verified_recipient');
  assert.equal(w.sent.length, 0);
});

test('booking cancelled after payment: suppressed, and the booking/payment rows are not modified', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  bookingOf(w).status = 'cancelled';
  const before = snapshot(w);
  assert.equal((await processDueNotifications(w.notifyDeps())).suppressed, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'booking_not_confirmed');
  assert.equal(snapshot(w), before);
  assert.equal(w.sent.length, 0);
});

test('a session already over, or a row older than 48h, is suppressed instead of sent late', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  clockAt(T0 + 49 * 60 * MIN); // past the booking's end (T0+24h+30min) and the 48h window
  assert.equal((await processDueNotifications(w.notifyDeps())).suppressed, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'booking_in_past');
  assert.equal(w.sent.length, 0);
});

test('SANDBOX (staging): suppressed by default, with no Cognito lookup', async () => {
  const w = await world({ environment: 'SANDBOX' });
  await confirmSuccessfulPayment(w.db, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  assert.equal(notificationsOf(w).length, 1, 'the durable record exists for SANDBOX too');
  assert.equal((await processDueNotifications(w.notifyDeps())).suppressed, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'sandbox_not_allowlisted');
  assert.deepEqual(w.lookups, []);
  assert.equal(w.sent.length, 0);
});

test('SANDBOX: sent only when the resolved account email is allowlisted', async () => {
  const other = await world({ environment: 'SANDBOX' });
  await confirmSuccessfulPayment(other.db, { provider: 'phonepe', providerOrderId: other.orderId, amountInr: '399.00' });
  assert.equal((await processDueNotifications(other.notifyDeps({ sandboxAllowlist: parseEmailAllowlist('qa@playxcafe.com') }))).suppressed, 1);
  assert.equal(other.sent.length, 0);

  const w = await world({ environment: 'SANDBOX' });
  await confirmSuccessfulPayment(w.db, { provider: 'phonepe', providerOrderId: w.orderId, amountInr: '399.00' });
  const summary = await processDueNotifications(w.notifyDeps({ sandboxAllowlist: parseEmailAllowlist(` QA@playxcafe.com , ${CUSTOMER_EMAIL.toUpperCase()} `) }));
  assert.equal(summary.sent, 1);
  assert.equal(w.sent[0].to, CUSTOMER_EMAIL);
});

// ------------------------------------------------------------------ handler switches

test('handler: disabled unless BOOKING_CONFIRMATION_EMAIL_ENABLED is exactly "true" — no DB access at all', async () => {
  for (const value of [undefined, '', 'false', 'TRUE', ' true']) {
    let dbCalls = 0;
    const handler = createNotifyHandler({
      getDb: async () => {
        dbCalls += 1;
        throw new Error('must not connect');
      },
      resetDb: () => {},
      resolveRecipient: async () => ({ kind: 'unavailable' }),
      sender: { sendBookingConfirmation: async () => 'x' },
      env: { BOOKING_CONFIRMATION_EMAIL_ENABLED: value },
    });
    assert.deepEqual(await handler({}), { disabled: true });
    assert.equal(dbCalls, 0);
  }
});

test('handler: enabled run sends and returns the summary; logs never contain the recipient or body', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const logged: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  const err = mock.method(console, 'error', (...args: unknown[]) => logged.push(args.map(String).join(' ')));
  try {
    const handler = createNotifyHandler({
      getDb: async () => createFakePaymentDbClient(w.store),
      resetDb: () => {},
      resolveRecipient: w.notifyDeps().resolveRecipient,
      sender: w.notifyDeps().sender,
      env: { BOOKING_CONFIRMATION_EMAIL_ENABLED: 'true' },
    });
    const summary = await handler({});
    assert.deepEqual(summary, { claimed: 1, sent: 1, suppressed: 0, retried: 0, failed: 0 });
  } finally {
    log.mock.restore();
    err.mock.restore();
  }
  assert.ok(logged.some((l) => l.includes('booking confirmation email sent')));
  for (const line of logged) {
    assert.ok(!line.includes(CUSTOMER_EMAIL), 'recipient address never logged');
    assert.ok(!line.includes(SUB), 'Cognito sub never logged');
    assert.ok(!line.includes('Race Xperience Hangout'), 'email body never logged');
  }
});

test('retry backoff: 1, 2, 4 ... minutes, capped at 60', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => retryDelaySeconds(n) / 60), [1, 2, 4, 8, 16, 32, 60, 60]);
});

// ------------------------------------------------------------------ Cognito eventual consistency

test('ListUsers returns zero at first: no email, row retryable; later run finds the account, sends once, SENT; never re-sent', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const cognitoCalls: string[] = [];
  let listUsers: () => unknown[] = () => [];
  (getCognitoClient() as any).send = async (cmd: any) => {
    const name = cmd.constructor.name;
    cognitoCalls.push(name);
    if (name === 'ListUsersCommand') {
      assert.equal(cmd.input.Filter, `sub = "${SUB}"`);
      return { Users: listUsers() };
    }
    if (name === 'AdminGetUserCommand') {
      assert.equal(cmd.input.Username, 'canonical-1', 'read by the canonical Username ListUsers returned');
      return {
        Enabled: true,
        UserAttributes: [
          { Name: 'sub', Value: SUB },
          { Name: 'email', Value: CUSTOMER_EMAIL },
          { Name: 'email_verified', Value: 'true' },
        ],
      };
    }
    throw new Error(`unexpected ${name}`);
  };
  const deps = () => w.notifyDeps({ resolveRecipient: (sub) => resolveVerifiedAccountEmail(sub, 'pool-1') });

  // Run 1: not visible yet.
  assert.deepEqual(await processDueNotifications(deps()), { claimed: 1, sent: 0, suppressed: 0, retried: 1, failed: 0 });
  assert.equal(w.sent.length, 0, 'no SES email');
  assert.deepEqual(cognitoCalls, ['ListUsersCommand'], 'no AdminGetUser without a match');
  let row = notificationsOf(w)[0];
  assert.equal(row.status, 'pending');
  assert.equal(row.last_error, 'recipient_not_found');
  assert.equal(row.next_attempt_at.getTime(), T0 + retryDelaySeconds(1) * 1000);

  // Run 2 (after backoff): the account is visible and verified.
  listUsers = () => [{ Username: 'canonical-1' }];
  clockAt(T0 + retryDelaySeconds(1) * 1000);
  assert.equal((await processDueNotifications(deps())).sent, 1);
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].to, CUSTOMER_EMAIL);
  row = notificationsOf(w)[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.attempt_count, 2);

  // Later runs: a SENT row is never claimed or sent again.
  for (const minutes of [5, 60, 24 * 60]) {
    clockAt(T0 + minutes * MIN);
    assert.equal((await processDueNotifications(deps())).claimed, 0);
  }
  assert.equal(w.sent.length, 1);
});

test('ListUsers zero matches until retries run out: the row ends failed, never sent', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  w.resolution = { kind: 'not_found' };
  let now = T0;
  for (let i = 1; i < MAX_ATTEMPTS; i += 1) {
    assert.equal((await processDueNotifications(w.notifyDeps())).retried, 1);
    now += retryDelaySeconds(i) * 1000;
    clockAt(now);
  }
  assert.equal((await processDueNotifications(w.notifyDeps())).failed, 1);
  assert.equal(notificationsOf(w)[0].last_error, 'recipient_not_found_retries_exhausted');
  assert.equal(w.sent.length, 0);
});

test('more than one matching Cognito user: never chosen arbitrarily — no AdminGetUser, no email, row failed', async () => {
  const w = await world();
  await confirmViaWebhook(w);
  const cognitoCalls: string[] = [];
  (getCognitoClient() as any).send = async (cmd: any) => {
    cognitoCalls.push(cmd.constructor.name);
    return { Users: [{ Username: 'a' }, { Username: 'b' }] };
  };
  const summary = await processDueNotifications(w.notifyDeps({ resolveRecipient: (sub) => resolveVerifiedAccountEmail(sub, 'pool-1') }));
  assert.equal(summary.failed, 1);
  assert.deepEqual(cognitoCalls, ['ListUsersCommand']);
  assert.equal(notificationsOf(w)[0].last_error, 'no_verified_recipient');
  assert.equal(w.sent.length, 0);
});
