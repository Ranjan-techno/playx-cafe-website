import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mock, test } from 'node:test';
import {
  allowedPriorStatuses,
  applyDeliveryEvent,
  canTransition,
  CORRELATION_RETRY_DELAYS_MS,
  DeliveryCorrelationPendingError,
  DELIVERY_STATUSES,
  parseSesDeliveryEvent,
  SES_EMAIL_EVENT_TYPES,
  type DeliveryStatus,
} from './booking-email-events';
import { createHandler, EmailEventsMisconfiguredError } from '../handlers/booking-email-events';
import {
  createFakePaymentDbClient,
  createFakePaymentDbStore,
  seedBooking,
  type FakeNotificationRow,
  type FakePaymentDbStore,
} from './test-support/fake-payment-db';
import {
  sesEvent,
  TEST_CONFIGURATION_SET,
  TEST_DIAGNOSTIC,
  TEST_RECIPIENT,
  TEST_RENDER_ERROR,
  TEST_SMTP_RESPONSE,
  type SesDetailType,
} from './test-support/ses-events';

// Stage 2G: the SES delivery-event consumer against the in-memory fake DB. The notification row is
// seeded as the Stage 2F sender leaves it after a tracked send (status 'sent', provider_message_id
// = SES MessageId, delivery_status 'accepted').

const NOW = new Date('2026-09-25T06:10:00.000Z');
const MESSAGE_ID = '0109019a2b3c4d5e-11111111-2222-3333-4444-555555555555-000000';

interface Fixture {
  store: FakePaymentDbStore;
  row: FakeNotificationRow;
  bookingId: string;
  handler: ReturnType<typeof createHandler>;
  /** Delays the handler "slept" for (the fake sleep never waits). */
  sleeps: number[];
  /** Runs inside each fake sleep — lets a test model the sender committing mid-invocation. */
  onSleep: (hook: (sleepIndex: number) => void) => void;
  event: (type: SesDetailType, opts?: Parameters<typeof sesEvent>[1]) => Record<string, unknown>;
  /** Everything outside booking_notifications' delivery columns. */
  untouched: () => string;
}

function fixture(overrides: Partial<FakeNotificationRow> = {}): Fixture {
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    id: randomUUID(),
    status: 'confirmed',
    priceInr: '399.00',
    allocationStatus: 'confirmed',
    bookingEnvironment: 'PRODUCTION',
    cognitoSub: 'sub-1',
  });
  store.payments.push({
    id: 'pay-1', booking_id: booking.id, provider: 'phonepe', provider_order_id: 'order-1', provider_transaction_id: 'txn-1',
    amount_inr: '399.00', currency: 'INR', payment_status: 'paid', failure_reason: null, metadata: {},
    created_at: NOW, updated_at: NOW, paid_at: NOW,
  } as never);
  const row: FakeNotificationRow = {
    id: randomUUID(),
    booking_id: booking.id,
    notification_type: 'BOOKING_CONFIRMED',
    status: 'sent',
    recipient_email: TEST_RECIPIENT,
    attempt_count: 1,
    next_attempt_at: NOW,
    last_attempt_at: NOW,
    last_error: null,
    provider_message_id: MESSAGE_ID,
    sent_at: new Date('2026-09-25T06:00:00.000Z'),
    created_at: NOW,
    updated_at: NOW,
    delivery_status: 'accepted',
    ...overrides,
  };
  store.notifications.push(row);
  const sleeps: number[] = [];
  let hook: (sleepIndex: number) => void = () => {};
  const handler = createHandler({
    getDb: async () => createFakePaymentDbClient(store),
    resetDb: () => {},
    env: { SES_CONFIGURATION_SET: TEST_CONFIGURATION_SET },
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
      hook(sleeps.length - 1);
    },
  });
  const untouched = () => {
    const { delivery_status, last_delivery_event_at, delivered_at, bounced_at, complained_at, delivery_failure_type, delivery_failure_subtype, updated_at, ...outbox } = row;
    void [delivery_status, last_delivery_event_at, delivered_at, bounced_at, complained_at, delivery_failure_type, delivery_failure_subtype, updated_at];
    return JSON.stringify({ bookings: store.bookings, payments: store.payments, allocations: store.allocations, outbox });
  };
  return {
    store,
    row,
    bookingId: booking.id,
    handler,
    sleeps,
    onSleep: (h) => (hook = h),
    event: (type, opts = {}) => sesEvent(type, { notificationId: row.id, messageId: MESSAGE_ID, ...opts }),
    untouched,
  };
}

async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const capture = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  const spies = [mock.method(console, 'log', capture), mock.method(console, 'warn', capture), mock.method(console, 'error', capture)];
  try {
    return { result: await fn(), logs };
  } finally {
    for (const spy of spies) spy.mock.restore();
  }
}

// ------------------------------------------------------------------ mapping + state machine

test('every tracked SES detail-type maps to its eventType and delivery status', () => {
  assert.deepEqual(
    Object.entries(SES_EMAIL_EVENT_TYPES).map(([detailType, s]) => [detailType, s.eventType, s.status]),
    [
      ['Email Sent', 'Send', 'accepted'],
      ['Email Delivered', 'Delivery', 'delivered'],
      ['Email Delivery Delayed', 'DeliveryDelay', 'delayed'],
      ['Email Bounced', 'Bounce', 'bounced'],
      ['Email Complaint Received', 'Complaint', 'complained'],
      ['Email Rejected', 'Reject', 'rejected'],
      ['Email Rendering Failed', 'Rendering Failure', 'rendering_failed'],
    ],
  );
});

test('state machine: forward only; terminal states never change; duplicates are no-ops', () => {
  const terminal: DeliveryStatus[] = ['bounced', 'complained', 'rejected', 'rendering_failed'];
  // allowed
  assert.ok(canTransition(null, 'delivered'), 'untracked/unknown -> any');
  assert.ok(canTransition('accepted', 'delivered'));
  assert.ok(canTransition('accepted', 'delayed') && canTransition('delayed', 'delivered'));
  assert.ok(canTransition('accepted', 'bounced'));
  assert.ok(canTransition('accepted', 'complained'));
  assert.ok(canTransition('delivered', 'complained'), 'a complaint follows a delivery');
  assert.ok(canTransition('delivered', 'bounced'), 'an asynchronous bounce after the MTA accepted it');
  // refused
  assert.ok(!canTransition('delivered', 'delayed'), 'delivered never goes back to delayed');
  assert.ok(!canTransition('delivered', 'accepted'));
  assert.ok(!canTransition('delayed', 'accepted'));
  for (const s of DELIVERY_STATUSES) assert.ok(!canTransition(s, s), `${s} -> ${s} is a no-op`);
  for (const from of terminal) {
    for (const to of DELIVERY_STATUSES) assert.ok(!canTransition(from, to), `${from} is terminal (-> ${to})`);
  }
  assert.deepEqual(allowedPriorStatuses('delayed'), ['accepted']);
  assert.deepEqual(allowedPriorStatuses('delivered'), ['accepted', 'delayed']);
  assert.deepEqual(allowedPriorStatuses('bounced'), ['accepted', 'delayed', 'delivered']);
});

// ------------------------------------------------------------------ each event type

const CASES: Array<[SesDetailType, DeliveryStatus, Partial<FakeNotificationRow>]> = [
  ['Email Delivered', 'delivered', { delivered_at: new Date('2026-09-25T06:05:00.000Z'), delivery_failure_type: null, delivery_failure_subtype: null }],
  ['Email Delivery Delayed', 'delayed', { delivery_failure_type: 'DeliveryDelay', delivery_failure_subtype: 'MailboxFull' }],
  ['Email Bounced', 'bounced', { bounced_at: new Date('2026-09-25T06:05:00.000Z'), delivery_failure_type: 'Permanent', delivery_failure_subtype: 'General' }],
  ['Email Complaint Received', 'complained', { complained_at: new Date('2026-09-25T06:05:00.000Z'), delivery_failure_type: 'Complaint', delivery_failure_subtype: 'abuse' }],
  ['Email Rejected', 'rejected', { delivery_failure_type: 'Reject', delivery_failure_subtype: 'Bad content' }],
  ['Email Rendering Failed', 'rendering_failed', { delivery_failure_type: 'RenderingFailure', delivery_failure_subtype: null }],
];

for (const [detailType, status, expected] of CASES) {
  test(`${detailType} -> ${status}; SES timestamp recorded; booking/payment/allocations/outbox untouched`, async () => {
    const f = fixture();
    const before = f.untouched();
    const { result } = await quietly(() => f.handler(f.event(detailType)));
    assert.deepEqual(result, { result: 'applied', from: 'accepted', to: status });
    assert.equal(f.row.delivery_status, status);
    // Reject / Rendering Failure carry no sub-object timestamp: EventBridge's `time` is used.
    assert.equal(f.row.last_delivery_event_at?.toISOString(), '2026-09-25T06:05:00.000Z');
    for (const [key, value] of Object.entries(expected)) {
      assert.deepEqual((f.row as unknown as Record<string, unknown>)[key], value, key);
    }
    assert.equal(f.untouched(), before);
  });
}

test('Email Sent on an untracked-at-send row (delivery_status NULL) -> accepted', async () => {
  const f = fixture({ delivery_status: null });
  const { result } = await quietly(() => f.handler(f.event('Email Sent')));
  assert.equal(result.result, 'applied');
  assert.equal(f.row.delivery_status, 'accepted');
});

test('accepted -> delayed -> delivered clears the delay reason; delivered_at kept', async () => {
  const f = fixture();
  await quietly(() => f.handler(f.event('Email Delivery Delayed', { at: '2026-09-25T06:02:00.000Z' })));
  assert.equal(f.row.delivery_status, 'delayed');
  assert.equal(f.row.delivery_failure_type, 'DeliveryDelay');
  await quietly(() => f.handler(f.event('Email Delivered', { at: '2026-09-25T06:07:00.000Z' })));
  assert.equal(f.row.delivery_status, 'delivered');
  assert.equal(f.row.delivered_at?.toISOString(), '2026-09-25T06:07:00.000Z');
  assert.equal(f.row.delivery_failure_type, null);
  assert.equal(f.row.delivery_failure_subtype, null);
});

// ------------------------------------------------------------------ idempotency + ordering

test('duplicate event is idempotent: second delivery changes nothing (not even timestamps)', async () => {
  const f = fixture();
  const event = f.event('Email Delivered');
  await quietly(() => f.handler(event));
  const after1 = JSON.stringify(f.row);
  const { result } = await quietly(() => f.handler(event));
  assert.deepEqual(result, { result: 'no_change', current: 'delivered', to: 'delivered' });
  assert.equal(JSON.stringify(f.row), after1);
});

test('out-of-order: a late DELIVERY_DELAY cannot downgrade delivered', async () => {
  const f = fixture();
  await quietly(() => f.handler(f.event('Email Delivered', { at: '2026-09-25T06:05:00.000Z' })));
  const { result } = await quietly(() => f.handler(f.event('Email Delivery Delayed', { at: '2026-09-25T06:01:00.000Z' })));
  assert.equal(result.result, 'no_change');
  assert.equal(f.row.delivery_status, 'delivered');
  assert.equal(f.row.delivery_failure_type, null);
  assert.equal(f.row.last_delivery_event_at?.toISOString(), '2026-09-25T06:05:00.000Z');
});

test('out-of-order: a late SEND cannot downgrade delayed/delivered; terminal bounce is never overwritten', async () => {
  const f = fixture();
  await quietly(() => f.handler(f.event('Email Bounced')));
  for (const type of ['Email Sent', 'Email Delivered', 'Email Delivery Delayed', 'Email Complaint Received', 'Email Rejected'] as const) {
    const { result } = await quietly(() => f.handler(f.event(type)));
    assert.equal(result.result, 'no_change', type);
  }
  assert.equal(f.row.delivery_status, 'bounced');
  assert.equal(f.row.delivery_failure_type, 'Permanent');
});

test('the UPDATE itself is guarded: a row that moved on after the SELECT is not downgraded', async () => {
  const f = fixture();
  const parsed = parseSesDeliveryEvent(f.event('Email Delivery Delayed'), TEST_CONFIGURATION_SET, NOW);
  assert.ok(parsed.ok);
  const db = createFakePaymentDbClient(f.store);
  // Simulate a concurrent DELIVERY landing between this event's SELECT and UPDATE.
  const racing = {
    async query(sql: string, params: unknown[]) {
      const res = await db.query(sql, params);
      if (/^SELECT id, status/.test(sql.trim())) f.row.delivery_status = 'delivered';
      return res;
    },
  };
  const outcome = await applyDeliveryEvent(racing as never, parsed.event);
  assert.equal(outcome.result, 'no_change');
  assert.equal(f.row.delivery_status, 'delivered');
});

// ------------------------------------------------------------------ never touches booking/payment/allocation

test('no event sequence ever modifies booking, payment, allocation or the outbox status/retry fields', async () => {
  const f = fixture();
  const before = f.untouched();
  const sequence: SesDetailType[] = ['Email Sent', 'Email Delivery Delayed', 'Email Delivered', 'Email Complaint Received', 'Email Bounced', 'Email Rejected', 'Email Rendering Failed', 'Email Delivered'];
  for (const type of sequence) await quietly(() => f.handler(f.event(type)));
  assert.equal(f.untouched(), before);
  assert.equal(f.store.bookings[0].status, 'confirmed');
  assert.equal(f.store.payments[0].payment_status, 'paid');
  assert.ok(f.store.allocations.every((a) => a.allocation_status === 'confirmed'));
  assert.equal(f.row.status, 'sent');
});

test('source: the module only ever issues SQL against booking_notifications (never bookings/payments/allocations)', () => {
  const src = readFileSync(path.join(__dirname, 'booking-email-events.ts'), 'utf8');
  const sql = [...src.matchAll(/`([^`]*)`/g)].map((m) => m[1]).join('\n');
  assert.match(sql, /FROM booking_notifications/);
  assert.match(sql, /UPDATE booking_notifications/);
  assert.doesNotMatch(sql, /\b(bookings|payments|booking_allocations|simulators)\b/);
  const setClause = /\bSET\b([\s\S]*?)\bWHERE\b/.exec(sql)?.[1] ?? '';
  const assigned = [...setClause.matchAll(/^\s*([a-z_]+) =/gm)].map((m) => m[1]);
  assert.deepEqual(assigned, ['delivery_status', 'last_delivery_event_at', 'delivered_at', 'bounced_at', 'complained_at', 'delivery_failure_type', 'delivery_failure_subtype', 'updated_at'], 'writes only Stage 2G columns');
  assert.doesNotMatch(src, /INSERT|DELETE FROM/);
});

// ------------------------------------------------------------------ correlation / rejection

test('correlation: messageId must match provider_message_id — a mismatched event changes nothing', async () => {
  const f = fixture();
  const { result } = await quietly(() => f.handler(f.event('Email Bounced', { messageId: 'some-other-message-000000' })));
  assert.deepEqual(result, { result: 'message_id_mismatch' });
  assert.equal(f.row.delivery_status, 'accepted');
});

test('unknown notification id is harmless: nothing changes, no throw', async () => {
  const f = fixture();
  const before = JSON.stringify(f.store);
  const { result, logs } = await quietly(() => f.handler(sesEvent('Email Bounced', { notificationId: randomUUID(), messageId: MESSAGE_ID })));
  assert.deepEqual(result, { result: 'unknown_notification' });
  assert.equal(JSON.stringify(f.store), before);
  assert.ok(logs.some((l) => l.includes('unknown_notification')));
});

test('failed / suppressed rows (SES never accepted them) are ignored, never retried', async () => {
  for (const status of ['failed', 'suppressed'] as const) {
    const f = fixture({ status, provider_message_id: null, delivery_status: null });
    const { result } = await quietly(() => f.handler(f.event('Email Delivered')));
    assert.deepEqual(result, { result: 'not_sent' });
    assert.equal(f.row.delivery_status, null);
    assert.deepEqual(f.sleeps, [], 'no correlation retry');
  }
});

// ------------------------------------------------------------------ early events (sender not yet recorded)

/** The row as it is between SES accepting the message and the sender's 'sent' commit. */
const NOT_YET_RECORDED = { status: 'pending', provider_message_id: null, delivery_status: null, sent_at: null } as const;

/** What the sender's markSent commit does to the row. */
function recordSent(row: FakeNotificationRow): void {
  row.status = 'sent';
  row.provider_message_id = MESSAGE_ID;
  row.delivery_status = 'accepted';
  row.sent_at = NOW;
}

test('early event 1: DELIVERY while the row is still pending; the second read sees SENT -> delivered', async () => {
  const f = fixture({ ...NOT_YET_RECORDED });
  f.onSleep((i) => i === 0 && recordSent(f.row));
  const { result } = await quietly(() => f.handler(f.event('Email Delivered')));
  assert.deepEqual(result, { result: 'applied', from: 'accepted', to: 'delivered' });
  assert.equal(f.row.delivery_status, 'delivered');
  assert.deepEqual(f.sleeps, [CORRELATION_RETRY_DELAYS_MS[0]]);
});

test('early event 2: provider_message_id NULL on the first reads, persisted by the last read -> applies', async () => {
  const f = fixture({ provider_message_id: null });
  f.onSleep((i) => i === 1 && (f.row.provider_message_id = MESSAGE_ID));
  const { result } = await quietly(() => f.handler(f.event('Email Bounced')));
  assert.deepEqual(result, { result: 'applied', from: 'accepted', to: 'bounced' });
  assert.equal(f.row.delivery_status, 'bounced');
  assert.deepEqual(f.sleeps, [...CORRELATION_RETRY_DELAYS_MS]);
});

test('early event 3: still pending after the bounded reads -> retriable error, row untouched, sanitized logs', async () => {
  const f = fixture({ ...NOT_YET_RECORDED });
  const before = JSON.stringify(f.store);
  const { logs } = await quietly(() => assert.rejects(f.handler(f.event('Email Delivered')), DeliveryCorrelationPendingError));
  assert.equal(JSON.stringify(f.store), before, 'nothing modified');
  assert.deepEqual(f.sleeps, [...CORRELATION_RETRY_DELAYS_MS], 'exactly 3 reads, 2 short waits');
  assert.ok(f.sleeps.reduce((a, b) => a + b, 0) <= 2000, 'total wait <= 2s');
  assert.equal(new DeliveryCorrelationPendingError().message.includes(f.row.id), false, 'error message has no ids');
  assert.ok(logs.some((l) => l.includes('booking-email-events retry') && l.includes('send_not_recorded_yet')));
  for (const secret of [TEST_RECIPIENT, TEST_SMTP_RESPONSE, MESSAGE_ID, '"mail"']) {
    for (const line of logs) assert.ok(!line.includes(secret), `log leaks ${secret}`);
  }
});

test('early events 4 + 5: the retried invocation applies once the row is ready; further retries are no-ops', async () => {
  const f = fixture({ ...NOT_YET_RECORDED });
  const event = f.event('Email Delivered');
  await quietly(() => assert.rejects(f.handler(event), DeliveryCorrelationPendingError));
  recordSent(f.row); // the sender commits before Lambda's async retry
  const { result } = await quietly(() => f.handler(event));
  assert.deepEqual(result, { result: 'applied', from: 'accepted', to: 'delivered' });
  const afterFirstApply = JSON.stringify(f.row);
  // Lambda may deliver the same event again (a second async retry, or EventBridge redelivery).
  const { result: again } = await quietly(() => f.handler(event));
  assert.deepEqual(again, { result: 'no_change', current: 'delivered', to: 'delivered' });
  assert.equal(JSON.stringify(f.row), afterFirstApply, 'no duplicate transition, timestamps unchanged');
});

test('early event 6: an unknown notification id is still ignored immediately — no wait, no throw', async () => {
  const f = fixture();
  const { result } = await quietly(() => f.handler(sesEvent('Email Delivered', { notificationId: randomUUID(), messageId: MESSAGE_ID })));
  assert.deepEqual(result, { result: 'unknown_notification' });
  assert.deepEqual(f.sleeps, []);
});

test('early event 7: a message-id mismatch on a fully recorded row is ignored — no retry, no mutation', async () => {
  const f = fixture();
  const before = JSON.stringify(f.row);
  const { result } = await quietly(() => f.handler(f.event('Email Delivered', { messageId: 'a-different-ses-message-000000' })));
  assert.deepEqual(result, { result: 'message_id_mismatch' });
  assert.equal(JSON.stringify(f.row), before);
  assert.deepEqual(f.sleeps, []);
});

test('a row that becomes ready with a DIFFERENT message id (the sender re-sent) is a mismatch, not applied', async () => {
  const f = fixture({ ...NOT_YET_RECORDED });
  f.onSleep(() => {
    recordSent(f.row);
    f.row.provider_message_id = 'resent-message-000000';
  });
  const { result } = await quietly(() => f.handler(f.event('Email Delivered')));
  assert.deepEqual(result, { result: 'message_id_mismatch' });
  assert.equal(f.row.delivery_status, 'accepted');
});

test('malformed / foreign events are ignored without touching the DB', async () => {
  const f = fixture();
  let dbCalls = 0;
  const handler = createHandler({
    getDb: async () => {
      dbCalls += 1;
      return createFakePaymentDbClient(f.store);
    },
    resetDb: () => {},
    env: { SES_CONFIGURATION_SET: TEST_CONFIGURATION_SET },
    now: () => NOW,
  });
  const good = f.event('Email Delivered');
  const withDetail = (patch: (d: Record<string, any>) => void) => {
    const e = structuredClone(good) as Record<string, any>;
    patch(e.detail);
    return e;
  };
  const cases: Array<[string, unknown]> = [
    ['not_an_object', null],
    ['not_an_object', 'Email Delivered'],
    ['not_an_object', [good]],
    ['wrong_source', { ...good, source: 'aws.sns' }],
    ['unsupported_detail_type', f.event('Email Opened')],
    ['unsupported_detail_type', f.event('Email Clicked')],
    ['unsupported_detail_type', { ...good, 'detail-type': 'constructor' }],
    ['missing_detail', { ...good, detail: 'x' }],
    ['event_type_mismatch', withDetail((d) => (d.eventType = 'Bounce'))],
    ['missing_mail', withDetail((d) => delete d.mail)],
    ['invalid_message_id', withDetail((d) => (d.mail.messageId = '<script>'))],
    ['configuration_set_mismatch', f.event('Email Delivered', { configurationSet: 'someone-elses-set' })],
    ['configuration_set_mismatch', f.event('Email Delivered', { configurationSet: null })],
    ['missing_notification_tag', f.event('Email Delivered', { notificationId: null })],
    ['missing_notification_tag', withDetail((d) => (d.mail.tags.playx_notification_id = [randomUUID(), randomUUID()]))],
    ['invalid_notification_tag', f.event('Email Delivered', { notificationId: "1'; DROP TABLE bookings;--" })],
  ];
  for (const [reason, event] of cases) {
    const { result } = await quietly(() => handler(event));
    assert.deepEqual(result, { result: 'ignored', reason }, `${reason}: ${JSON.stringify(event)?.slice(0, 80)}`);
  }
  assert.equal(dbCalls, 0);
  assert.equal(f.row.delivery_status, 'accepted');
});

test('untrustworthy SES timestamps fall back to EventBridge time, then to now', () => {
  const f = fixture();
  const future = parseSesDeliveryEvent(f.event('Email Delivered', { at: '2099-01-01T00:00:00.000Z', eventBridgeTime: '2026-09-25T06:06:00Z' }), TEST_CONFIGURATION_SET, NOW);
  assert.ok(future.ok);
  assert.equal(future.event.eventAt.toISOString(), '2026-09-25T06:06:00.000Z');
  const garbage = parseSesDeliveryEvent(f.event('Email Delivered', { at: 'yesterday', eventBridgeTime: 'soon' }), TEST_CONFIGURATION_SET, NOW);
  assert.ok(garbage.ok);
  assert.equal(garbage.event.eventAt.toISOString(), NOW.toISOString());
});

test('failure type/subtype are charset-restricted; free text is dropped, never stored', async () => {
  const f = fixture();
  await quietly(() => f.handler(f.event('Email Bounced', { bounceType: 'Permanent', bounceSubType: `550 <${TEST_RECIPIENT}> user unknown` })));
  assert.equal(f.row.delivery_failure_type, 'Permanent');
  assert.equal(f.row.delivery_failure_subtype, null);
});

// ------------------------------------------------------------------ logging / storage hygiene

test('no PII or raw SES body is logged or stored', async () => {
  const f = fixture();
  const all: string[] = [];
  for (const type of ['Email Delivery Delayed', 'Email Delivered', 'Email Bounced', 'Email Rendering Failed'] as const) {
    const { logs } = await quietly(() => f.handler(f.event(type)));
    all.push(...logs);
  }
  const { logs: ignoredLogs } = await quietly(() => f.handler(f.event('Email Delivered', { configurationSet: 'other' })));
  all.push(...ignoredLogs);
  // recipient_email / provider_message_id are the Stage 2F sender's own fields, not written here.
  const stored = JSON.stringify({ ...f.row, recipient_email: undefined, provider_message_id: undefined });
  for (const secret of [TEST_RECIPIENT, TEST_SMTP_RESPONSE, TEST_DIAGNOSTIC, TEST_RENDER_ERROR, 'bookings@playxcafe.com', 'Booking #1040', 'a8-50.smtp-out', MESSAGE_ID, '"mail"', '"detail"']) {
    for (const line of all) assert.ok(!line.includes(secret), `log leaks ${secret}: ${line}`);
    assert.ok(!stored.includes(secret), `row stores ${secret}`);
  }
  assert.ok(all.some((l) => l.includes('booking-email-events applied') && l.includes(f.row.id)));
});

// ------------------------------------------------------------------ handler failure modes

test('fails closed without a valid SES_CONFIGURATION_SET; a DB error throws (alarm + safe retry)', async () => {
  const f = fixture();
  for (const env of [{}, { SES_CONFIGURATION_SET: '' }, { SES_CONFIGURATION_SET: 'bad name!' }]) {
    const handler = createHandler({ getDb: async () => createFakePaymentDbClient(f.store), resetDb: () => {}, env });
    await quietly(() => assert.rejects(handler(f.event('Email Delivered')), EmailEventsMisconfiguredError));
  }
  let resets = 0;
  const failing = createHandler({
    getDb: async () => ({ query: async () => { throw Object.assign(new Error('connection reset'), { name: 'DatabaseError' }); } }) as never,
    resetDb: () => (resets += 1),
    env: { SES_CONFIGURATION_SET: TEST_CONFIGURATION_SET },
  });
  await quietly(() => assert.rejects(failing(f.event('Email Delivered')), /connection reset/));
  assert.equal(resets, 1);
  assert.equal(f.row.delivery_status, 'accepted');
});

test('migration 009 missing: the consumer throws (alarm) and changes nothing', async () => {
  const f = fixture();
  f.store.deliveryColumnsMissing = true;
  await quietly(() => assert.rejects(f.handler(f.event('Email Delivered')), (err: Error & { code?: string }) => err.code === '42703'));
  assert.equal(f.row.delivery_status, 'accepted');
});
