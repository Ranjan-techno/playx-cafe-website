import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, mock, test } from 'node:test';
import type { SQSEvent } from 'aws-lambda';
import { ensureFastReconcileScheduled, FAST_RECONCILE_ENVIRONMENT } from '../lib/fast-reconcile-payment';
import { PaymentProviderError } from '../lib/payment-errors';
import { startPayment } from '../lib/start-payment';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking } from '../lib/test-support/fake-payment-db';
import { FakeReconcileQueue } from '../lib/test-support/fake-reconcile-queue';
import { ScriptedProvider } from '../lib/test-support/scripted-provider';
import { createHandler } from './payment-reconcile-production-fast';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;
const QUEUE_URL = 'https://sqs.ap-south-1.amazonaws.com/123456789012/playx-dev-payment-reconcile-production-fast';

afterEach(() => mock.timers.reset());

function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

function sqsEvent(...bodies: string[]): SQSEvent {
  return { Records: bodies.map((body, i) => ({ messageId: `m-${i}`, body })) } as unknown as SQSEvent;
}

async function world(env: Record<string, string | undefined> = { PAYMENT_RECONCILE_QUEUE_URL: QUEUE_URL }) {
  clockAt(T0);
  const store = createFakePaymentDbStore();
  const booking = seedBooking(store, {
    priceInr: '999.00',
    holdExpiresAt: new Date(T0 + 15 * MIN),
    start: new Date(T0 + 24 * 60 * MIN),
    simulatorIds: ['sim-S1'],
    bookingEnvironment: 'PRODUCTION',
  });
  const db = createFakePaymentDbClient(store);
  const provider = new ScriptedProvider(db);
  provider.environment = 'PRODUCTION';
  await startPayment(db, provider, {
    bookingId: booking.id,
    environment: 'PRODUCTION',
    checkoutHoldMinutes: 20,
    description: 'x',
    generateProviderOrderId: () => 'ord-prod-1',
  });
  // Real payments.id values are UUIDs (the SQS message format requires one).
  const paymentId = randomUUID();
  store.payments[0].id = paymentId;
  const queue = new FakeReconcileQueue();
  await ensureFastReconcileScheduled(db, queue, paymentId);
  const calls = { getDb: 0, resetDb: 0, getProvider: 0, getQueue: 0 };
  const handler = createHandler({
    getDb: async () => {
      calls.getDb += 1;
      return db;
    },
    resetDb: () => {
      calls.resetDb += 1;
    },
    getProvider: async () => {
      calls.getProvider += 1;
      return provider;
    },
    getQueue: (url) => {
      calls.getQueue += 1;
      assert.equal(url, QUEUE_URL);
      return queue;
    },
    env,
  });
  return { store, provider, queue, paymentId, handler, calls };
}

function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = mock.method(console, 'log', () => {});
  const err = mock.method(console, 'error', () => {});
  return fn().finally(() => {
    log.mock.restore();
    err.mock.restore();
  });
}

test('the fast worker is PRODUCTION-only by code constant', () => {
  assert.equal(FAST_RECONCILE_ENVIRONMENT, 'PRODUCTION');
});

test('malformed messages are acknowledged safely: no DB, no provider, no requeue', async () => {
  const w = await world();
  const bodies = [
    '', 'not json', '[]', 'null', '{}',
    JSON.stringify({ paymentId: 'payment-1', seq: 1 }),
    JSON.stringify({ paymentId: w.paymentId }),
    JSON.stringify({ paymentId: w.paymentId, seq: 0 }),
    JSON.stringify({ paymentId: w.paymentId, seq: '1' }),
    JSON.stringify({ paymentId: w.paymentId, seq: 1.5 }),
  ];
  const results = await quietly(() => w.handler(sqsEvent(...bodies)));
  assert.deepEqual(results, []);
  assert.equal(w.calls.getDb + w.calls.getProvider, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.queue.sent.length, 1, 'only the initial link');
});

test('a valid message runs one link: PENDING at t=22 -> requeued 3s later', async () => {
  const w = await world();
  clockAt(T0 + 22_000);
  const results = await quietly(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 1 }))));
  assert.equal(results[0].result, 'requeued');
  assert.equal(results[0].nextDelaySeconds, 3);
  assert.deepEqual(w.queue.sent[1], { message: { paymentId: w.paymentId, seq: 2 }, delaySeconds: 3 });
});

test('message fields other than paymentId/seq (environment, amount, order id, status) are ignored', async () => {
  const w = await world();
  clockAt(T0 + 22_000);
  const body = JSON.stringify({ paymentId: w.paymentId, seq: 1, environment: 'SANDBOX', amountInr: '1.00', merchantOrderId: 'evil', status: 'paid' });
  const results = await quietly(() => w.handler(sqsEvent(body)));
  assert.equal(results[0].result, 'requeued');
  assert.deepEqual(w.provider.statusCalls, ['ord-prod-1'], 'order id from the DB row, not the message');
  assert.equal(w.store.payments[0].payment_status, 'pending');
});

test('runtime environment variables cannot switch the worker to SANDBOX', async () => {
  const w = await world({ PAYMENT_RECONCILE_QUEUE_URL: QUEUE_URL, PHONEPE_ENVIRONMENT: 'SANDBOX', RECONCILER_ENVIRONMENT: 'SANDBOX' });
  w.store.payments[0].payment_environment = 'SANDBOX';
  const results = await quietly(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 1 }))));
  assert.equal(results[0].result, 'environment_mismatch');
  assert.equal(w.calls.getProvider, 0);
});

test('missing/invalid queue URL: the invocation fails (retry -> DLQ) before any DB or provider work', async () => {
  for (const url of [undefined, '', ' ', 'not-a-url', 'http://sqs.example/q']) {
    const w = await world({ PAYMENT_RECONCILE_QUEUE_URL: url });
    await quietly(() => assert.rejects(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 1 }))), /not configured/));
    assert.equal(w.calls.getDb + w.calls.getProvider + w.calls.getQueue, 0, JSON.stringify(url));
  }
});

test('unexpected provider/DB error: the handler throws for SQS retry and drops the DB connection; nothing requeued', async () => {
  const w = await world();
  w.provider.statuses.set('ord-prod-1', new PaymentProviderError('PhonePe order status failed (HTTP 500)', false, 500));
  clockAt(T0 + 22_000);
  await quietly(() => assert.rejects(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 1 })))));
  assert.equal(w.calls.resetDb, 1);
  assert.equal(w.queue.sent.length, 1);
});

test('duplicate invocation with the same message is idempotent', async () => {
  const w = await world();
  clockAt(T0 + 22_000);
  const body = JSON.stringify({ paymentId: w.paymentId, seq: 1 });
  const first = await quietly(() => w.handler(sqsEvent(body)));
  const second = await quietly(() => w.handler(sqsEvent(body)));
  assert.equal(first[0].result, 'requeued');
  assert.equal(second[0].result, 'stale_message');
  assert.equal(w.provider.statusCalls.length, 1);
  assert.equal(w.queue.sent.length, 2);
});

test('logs carry ids/results only — never checkout URLs', async () => {
  const w = await world();
  clockAt(T0 + 22_000);
  const lines: string[] = [];
  const log = mock.method(console, 'log', (...args: unknown[]) => lines.push(args.join(' ')));
  try {
    await w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 1 })));
  } finally {
    log.mock.restore();
  }
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => !l.includes('pay.test') && !l.includes('redirect')));
});

test('gap (row seq 1, message seq 3): the handler throws for SQS retry -> DLQ, never acknowledges; no provider call', async () => {
  const w = await world();
  clockAt(T0 + 22_000);
  await quietly(() =>
    assert.rejects(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 3 }))), { name: 'FastReconcileConsistencyError' }),
  );
  assert.equal(w.calls.resetDb, 1);
  assert.equal(w.calls.getProvider, 0);
  assert.equal(w.queue.sent.length, 1);
});

test('a delivered next link whose sender never recorded it self-activates through the handler', async () => {
  const w = await world();
  clockAt(T0 + 25_000);
  const results = await quietly(() => w.handler(sqsEvent(JSON.stringify({ paymentId: w.paymentId, seq: 2 }))));
  assert.equal(results[0].result, 'requeued');
  assert.equal(results[0].selfActivated, true);
  assert.equal((w.store.payments[0].metadata as { fastReconcileSeq?: number }).fastReconcileSeq, 3);
});
