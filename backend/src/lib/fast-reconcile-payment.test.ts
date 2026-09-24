import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import type { DbClient } from './allocate-simulators';
import {
  ensureFastReconcileScheduled,
  fastReconcilePayment,
  FastReconcileConsistencyError,
  FastReconcileScheduleError,
  type FastReconcileDeps,
} from './fast-reconcile-payment';
import { PaymentProviderError } from './payment-errors';
import type { CreatePaymentRequest, CreatePaymentResult } from './payment-provider';
import { createPaymentAttempt, markPaymentPaid } from './payment-repository';
import { startPayment } from './start-payment';
import { createFakePaymentDbClient, createFakePaymentDbStore, seedBooking, type FakePaymentDbStore } from './test-support/fake-payment-db';
import { FakeReconcileQueue } from './test-support/fake-reconcile-queue';
import { ScriptedProvider } from './test-support/scripted-provider';

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;

afterEach(() => mock.timers.reset());

function clockAt(ms: number): void {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: ms });
}

/** A PRODUCTION PhonePe-like provider that (optionally) reports the order's expiry. */
class ProdProvider extends ScriptedProvider {
  environment: 'SANDBOX' | 'PRODUCTION' = 'PRODUCTION';
  reportedExpiry?: Date;
  async createPayment(request: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const result = await super.createPayment(request);
    return this.reportedExpiry ? { ...result, providerExpiresAt: this.reportedExpiry } : result;
  }
}

interface World {
  store: FakePaymentDbStore;
  db: ReturnType<typeof createFakePaymentDbClient>;
  provider: ProdProvider;
  queue: FakeReconcileQueue;
  paymentId: string;
  bookingId: string;
  providerCalls: { count: number };
  deps: FastReconcileDeps;
}

/** A real PRODUCTION attempt created through startPayment() at T0 (order expires T0+20min), with
 *  its first fast-chain link scheduled. */
async function prodAttempt(opts: { reportedExpiry?: Date; schedule?: boolean } = {}): Promise<World> {
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
  const provider = new ProdProvider(db);
  provider.reportedExpiry = opts.reportedExpiry;
  const started = await startPayment(db, provider, {
    bookingId: booking.id,
    environment: 'PRODUCTION',
    checkoutHoldMinutes: 20,
    description: 'Solo Motion 30 min',
    generateProviderOrderId: () => 'ord-prod-1',
  });
  const queue = new FakeReconcileQueue();
  if (opts.schedule !== false) {
    assert.equal(await ensureFastReconcileScheduled(db, queue, started.paymentId), 'scheduled');
  }
  const providerCalls = { count: 0 };
  const deps: FastReconcileDeps = {
    db,
    queue,
    getProvider: async () => {
      providerCalls.count += 1;
      return provider;
    },
  };
  return { store, db, provider, queue, paymentId: started.paymentId, bookingId: booking.id, providerCalls, deps };
}

const payment = (w: World) => w.store.payments.find((p) => p.id === w.paymentId)!;
const seq = (w: World) => (payment(w).metadata as { fastReconcileSeq?: number }).fastReconcileSeq;
/** A client over the same store whose fastReconcileSeq CAS throws — the process "dies" (or the DB
 *  fails) after SendMessage succeeded but before the advance is recorded. */
function casFails(w: World): DbClient {
  const db = createFakePaymentDbClient(w.store);
  return {
    ...db,
    query: async (text: string, params?: unknown[]) => {
      if (/'fastReconcileSeq'/.test(text)) throw new Error('connection terminated');
      return db.query(text, params);
    },
  } as DbClient;
}
const sentSeqs = (w: World) => w.queue.sent.map((s) => s.message.seq);
const success = { outcome: 'SUCCESS' as const, amountInr: '999.00', currency: 'INR', providerTransactionId: 'TX-1' };

// ------------------------------------------------------------------ first link (payment start)

test('first link: 22s after initiation, local payment id + seq 1 only; initiation/expiry persisted on the row', async () => {
  const w = await prodAttempt();
  assert.deepEqual(w.queue.sent, [{ message: { paymentId: w.paymentId, seq: 1 }, delaySeconds: 22 }]);
  assert.equal(seq(w), 1);
  const metadata = payment(w).metadata as Record<string, unknown>;
  assert.equal(metadata.paymentInitiatedAt, new Date(T0).toISOString());
  assert.equal(metadata.orderExpiresAt, new Date(T0 + 20 * MIN).toISOString());
  assert.equal(metadata.providerExpiresAt, undefined, 'provider reported none');
});

test('first link: the provider-reported expiry is persisted (normalized ISO) and caps the first delay', async () => {
  const w = await prodAttempt({ reportedExpiry: new Date(T0 + 19 * MIN) });
  assert.equal((payment(w).metadata as Record<string, unknown>).providerExpiresAt, new Date(T0 + 19 * MIN).toISOString());

  const short = await prodAttempt({ reportedExpiry: new Date(T0 + 10 * SEC) });
  assert.equal(short.queue.sent[0].delaySeconds, 10, 'never scheduled past the provider expiry');
});

test('ensure on a started chain never trusts seq > 0: it sends a recovery copy of the CURRENT link, seq untouched', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 30 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(w.queue.sent[1], { message: { paymentId: w.paymentId, seq: 1 }, delaySeconds: 0 }, 'delay 0: the chain may be overdue');
  assert.equal(seq(w), 1);
});

test('recovery before the first check is due waits for t=22 (never earlier than PhonePe\'s cadence)', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 5 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(w.queue.sent[1], { message: { paymentId: w.paymentId, seq: 1 }, delaySeconds: 17 });
});

test('recovery is never sent once the fast window has ended (fast_window_ended; nothing sent, seq untouched)', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 20 * MIN);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'fast_window_ended');
  assert.equal(w.queue.attempts, 1);
  assert.equal(seq(w), 1);
});

test('ensure: send happens BEFORE the seq is recorded (the row is still seq 0 at the moment of SendMessage)', async () => {
  const w = await prodAttempt({ schedule: false });
  const atSend: (number | undefined)[] = [];
  w.queue.onSend = () => atSend.push(seq(w));
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'scheduled');
  assert.deepEqual(atSend, [undefined]);
  assert.equal(seq(w), 1);
});

test('A. first send failure: seq never moves (nothing to roll back); a later retry sends seq 1 at the delay for the attempt\'s real age', async () => {
  const w = await prodAttempt({ schedule: false });
  w.queue.sendError = new Error('AccessDenied');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  assert.equal(seq(w), undefined, 'the sequence was never written');
  assert.equal(w.queue.sent.length, 0);

  w.queue.sendError = undefined;
  clockAt(T0 + 5 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'scheduled');
  assert.deepEqual(w.queue.sent, [{ message: { paymentId: w.paymentId, seq: 1 }, delaySeconds: 17 }], 'still first check at t=22');
});

test('ensure: never chains a non-open or non-PRODUCTION attempt', async () => {
  const w = await prodAttempt({ schedule: false });
  payment(w).payment_status = 'failed';
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'not_open');

  const sandboxBooking = seedBooking(w.store, { priceInr: '999.00', bookingEnvironment: 'SANDBOX', simulatorIds: ['sim-S2'] });
  const sandbox = await createPaymentAttempt(w.db, {
    bookingId: sandboxBooking.id, provider: 'phonepe', providerOrderId: 'ord-sb', amountInr: '999.00', paymentEnvironment: 'SANDBOX',
    metadata: { checkout: { redirectUrl: 'https://pay.test/ord-sb' }, orderExpiresAt: new Date(T0 + 20 * MIN).toISOString() },
  });
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, sandbox.id), /not a PRODUCTION payment attempt/);
  assert.equal(w.queue.attempts, 0);
});

// ------------------------------------------------------------------ worker: outcomes

test('PENDING at t=22: goes through the shared reconcile path, then requeues the next link 3s later (seq 2)', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 22 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.deepEqual(result, { result: 'requeued', paymentId: w.paymentId, nextDelaySeconds: 3, nextSeq: 2 });
  assert.deepEqual(w.provider.statusCalls, ['ord-prod-1'], 'authoritative order id from the row');
  assert.deepEqual(w.queue.sent[1], { message: { paymentId: w.paymentId, seq: 2 }, delaySeconds: 3 });
  assert.equal(seq(w), 2);
  assert.equal(payment(w).payment_status, 'pending');
  assert.equal((payment(w).metadata as Record<string, unknown>).reconcileCheckedAt, new Date(T0 + 22 * SEC).toISOString());
});

test('PENDING requeue delays follow the schedule across the chain (6s after t=52, 60s after t=232)', async () => {
  const w = await prodAttempt();
  const cases: [number, number][] = [[52, 6], [112, 10], [172, 30], [232, 60]];
  let current = 1;
  for (const [t, delay] of cases) {
    clockAt(T0 + t * SEC);
    const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: current });
    assert.equal(result.nextDelaySeconds, delay, `t=${t}`);
    current = result.nextSeq!;
  }
});

test('COMPLETED stops the chain: payment PAID, booking CONFIRMED, no requeue', async () => {
  const w = await prodAttempt();
  w.provider.statuses.set('ord-prod-1', success);
  clockAt(T0 + 22 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.result, 'confirmed');
  assert.equal(payment(w).payment_status, 'paid');
  assert.equal(w.store.bookings.find((b) => b.id === w.bookingId)?.status, 'confirmed');
  assert.equal(w.queue.sent.length, 1, 'only the initial link');
});

test('FAILED stops the chain: payment failed, booking keeps its hold, no requeue', async () => {
  const w = await prodAttempt();
  w.provider.statuses.set('ord-prod-1', { outcome: 'FAILED', failureReason: 'PAYMENT_ERROR' });
  clockAt(T0 + 25 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.result, 'failed');
  assert.equal(payment(w).payment_status, 'failed');
  assert.equal(w.store.bookings.find((b) => b.id === w.bookingId)?.status, 'pending');
  assert.equal(w.queue.sent.length, 1);
});

test('already-terminal payment: acknowledged with no provider load/call and no requeue', async () => {
  const w = await prodAttempt();
  await markPaymentPaid(w.db, w.paymentId, 'TX-EARLIER');
  clockAt(T0 + 22 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.result, 'terminal');
  assert.equal(w.providerCalls.count, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.queue.sent.length, 1);
});

test('expiry reached: the provider is still checked once more, but the fast chain stops (fallback takes over)', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 20 * MIN);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.result, 'fast_window_ended');
  assert.equal(w.provider.statusCalls.length, 1);
  assert.equal(w.queue.sent.length, 1, 'no link past the expiry');
  assert.equal(seq(w), 1);
});

test('expiry truncation: with 10s left the next link is 10s (not 60s); the provider\'s own expiry wins over ours', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 20 * MIN - 10 * SEC);
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).nextDelaySeconds, 10);

  const p = await prodAttempt({ reportedExpiry: new Date(T0 + 5 * MIN) });
  clockAt(T0 + 5 * MIN - 7 * SEC);
  assert.equal((await fastReconcilePayment(p.deps, { paymentId: p.paymentId, seq: 1 })).nextDelaySeconds, 7);
  clockAt(T0 + 5 * MIN);
  assert.equal((await fastReconcilePayment(p.deps, { paymentId: p.paymentId, seq: 2 })).result, 'fast_window_ended');
});

test('a provider expiry first seen on a status check is backfilled and then bounds the chain', async () => {
  const w = await prodAttempt();
  const scriptedStatus = w.provider.getPaymentStatus.bind(w.provider);
  w.provider.getPaymentStatus = async (id) => ({ ...(await scriptedStatus(id)), providerExpiresAt: new Date(T0 + 30 * SEC) });
  clockAt(T0 + 28 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.nextDelaySeconds, 2);
  assert.equal((payment(w).metadata as Record<string, unknown>).providerExpiresAt, new Date(T0 + 30 * SEC).toISOString());
});

// ------------------------------------------------------------------ worker: environment / trust

test('a SANDBOX payment can never reach the PRODUCTION provider (acknowledged, provider never loaded)', async () => {
  const w = await prodAttempt();
  const sandboxBooking = seedBooking(w.store, { priceInr: '999.00', bookingEnvironment: 'SANDBOX', simulatorIds: ['sim-S2'] });
  const sandbox = await createPaymentAttempt(w.db, {
    bookingId: sandboxBooking.id, provider: 'phonepe', providerOrderId: 'ord-sb', amountInr: '999.00', paymentEnvironment: 'SANDBOX',
    metadata: { checkout: { redirectUrl: 'https://pay.test/ord-sb' }, fastReconcileSeq: 1 },
  });
  const nullEnv = await createPaymentAttempt(w.db, {
    bookingId: sandboxBooking.id, provider: 'phonepe', providerOrderId: 'ord-null', amountInr: '999.00', paymentEnvironment: 'SANDBOX',
    metadata: { checkout: { redirectUrl: 'https://pay.test/ord-null' }, fastReconcileSeq: 1 },
  });
  w.store.payments.find((p) => p.id === nullEnv.id)!.payment_environment = null;
  for (const id of [sandbox.id, nullEnv.id]) {
    const result = await fastReconcilePayment(w.deps, { paymentId: id, seq: 1 });
    assert.equal(result.result, 'environment_mismatch');
  }
  assert.equal(w.providerCalls.count, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.queue.sent.length, 1);
});

test('unknown payment id: acknowledged safely, nothing else touched', async () => {
  const w = await prodAttempt();
  const result = await fastReconcilePayment(w.deps, { paymentId: '00000000-0000-4000-8000-000000000000', seq: 1 });
  assert.equal(result.result, 'unknown_payment');
  assert.equal(w.providerCalls.count, 0);
});

test('a provider configured for SANDBOX (wrong secret) is refused before any status call — throws for SQS retry/DLQ', async () => {
  const w = await prodAttempt();
  w.provider.environment = 'SANDBOX';
  clockAt(T0 + 22 * SEC);
  await assert.rejects(() => fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 }), /configured for SANDBOX, not PRODUCTION/);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.queue.sent.length, 1);
});

test('no live provider order recorded: acknowledged, no provider call', async () => {
  const w = await prodAttempt();
  const row = payment(w);
  row.metadata = { ...(row.metadata ?? {}), checkout: undefined };
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(result.result, 'no_live_order');
  assert.equal(w.providerCalls.count, 0);
});

// ------------------------------------------------------------------ worker: duplicates / failures

test('duplicate delivery (sequential): the second copy is stale — no provider call, no second link', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 22 * SEC);
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'requeued');
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'stale_message');
  assert.equal(w.provider.statusCalls.length, 1);
  assert.equal(w.queue.sent.length, 2, 'initial + exactly one follow-up');
});

test('duplicate delivery (concurrent): at most one follow-up link is ever scheduled — the chain never forks', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 22 * SEC);
  const other: FastReconcileDeps = { ...w.deps, db: createFakePaymentDbClient(w.store) };
  const results = await Promise.all([
    fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 }),
    fastReconcilePayment(other, { paymentId: w.paymentId, seq: 1 }),
  ]);
  const kinds = results.map((r) => r.result).sort();
  assert.ok(kinds.includes('requeued'));
  assert.ok(kinds.every((k) => k === 'requeued' || k === 'superseded' || k === 'stale_message'), kinds.join());
  assert.equal(kinds.filter((k) => k === 'requeued').length, 1, 'only one caller records the next link');
  // Send-first: a copy that lost may already have sent its own seq 2 — a same-seq duplicate only.
  assert.ok(w.queue.sent.length === 2 || w.queue.sent.length === 3, String(w.queue.sent.length));
  assert.ok(sentSeqs(w).slice(1).every((s) => s === 2), sentSeqs(w).join());
  assert.equal(seq(w), 2);
});

test('duplicate delivery after a success is harmless: no double confirmation, no requeue', async () => {
  const w = await prodAttempt();
  w.provider.statuses.set('ord-prod-1', success);
  clockAt(T0 + 22 * SEC);
  await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  const again = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(again.result, 'terminal');
  assert.equal(w.store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(w.store.allocations.filter((a) => a.allocation_status === 'confirmed').length, 1);
});

test('unexpected provider error: throws (SQS retry), no link scheduled; the retried message then continues the chain', async () => {
  const w = await prodAttempt();
  w.provider.statuses.set('ord-prod-1', new PaymentProviderError('PhonePe order status failed (HTTP 503)', false, 503));
  clockAt(T0 + 22 * SEC);
  await assert.rejects(() => fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 }), PaymentProviderError);
  assert.equal(w.queue.sent.length, 1);
  assert.equal(seq(w), 1, 'the same message is still the live link');

  w.provider.statuses.delete('ord-prod-1');
  clockAt(T0 + 60 * SEC); // redelivered after the visibility timeout
  const retried = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(retried.result, 'requeued');
  assert.equal(retried.nextDelaySeconds, 6, 'cadence continues from the attempt\'s real age');
});

test('unexpected DB error: throws, provider never called, nothing enqueued', async () => {
  const w = await prodAttempt();
  const broken: DbClient = { query: async () => { throw new Error('connection terminated'); } } as DbClient;
  await assert.rejects(() => fastReconcilePayment({ ...w.deps, db: broken }, { paymentId: w.paymentId, seq: 1 }), /connection terminated/);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.equal(w.queue.sent.length, 1);
});

test('requeue send failure: throws with the seq untouched, so the redelivered message sends the link again', async () => {
  const w = await prodAttempt();
  w.queue.sendError = new Error('ServiceUnavailable');
  clockAt(T0 + 22 * SEC);
  await assert.rejects(() => fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 }), FastReconcileScheduleError);
  assert.equal(seq(w), 1);
  w.queue.sendError = undefined;
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'requeued');
  assert.equal(seq(w), 2);
});

// ------------------------------------------------------------------ send-first protocol: failure windows

test('B. crash/DB failure after a successful first send: the delivered seq 1 self-activates 0 -> 1 and the chain continues', async () => {
  const w = await prodAttempt({ schedule: false });
  await assert.rejects(() => ensureFastReconcileScheduled(casFails(w), w.queue, w.paymentId), FastReconcileScheduleError);
  assert.deepEqual(sentSeqs(w), [1], 'the message is out');
  assert.equal(seq(w), undefined, 'but the advance was never recorded');

  clockAt(T0 + 22 * SEC);
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.deepEqual(result, { result: 'requeued', paymentId: w.paymentId, nextDelaySeconds: 3, nextSeq: 2, selfActivated: true });
  assert.deepEqual(w.provider.statusCalls, ['ord-prod-1']);
  assert.deepEqual(sentSeqs(w), [1, 2]);
  assert.equal(seq(w), 2);
});

test('C. ambiguous send failure (enqueued, then threw): seq stays 0; the delivered message self-activates; a customer retry\'s duplicate seq 1 is harmless', async () => {
  const w = await prodAttempt({ schedule: false });
  w.queue.ambiguousError = new Error('TimeoutError');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  assert.equal(seq(w), undefined);
  assert.deepEqual(sentSeqs(w), [1]);

  // Customer retry before delivery: sends seq 1 again and records it.
  w.queue.ambiguousError = undefined;
  clockAt(T0 + 3 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'scheduled');
  assert.deepEqual(sentSeqs(w), [1, 1]);
  assert.equal(seq(w), 1);

  // Both copies are delivered: one live link, one stale — a single logical chain.
  clockAt(T0 + 22 * SEC);
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'requeued');
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'stale_message');
  assert.equal(w.provider.statusCalls.length, 1);
  assert.deepEqual(sentSeqs(w), [1, 1, 2]);
  assert.equal(seq(w), 2);
});

test('C\'. ambiguous send, delivery BEFORE the customer retries: self-activation, then the retry sends a recovery copy of the current link', async () => {
  const w = await prodAttempt({ schedule: false });
  w.queue.ambiguousError = new Error('TimeoutError');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  w.queue.ambiguousError = undefined;

  clockAt(T0 + 22 * SEC);
  const delivered = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 });
  assert.equal(delivered.selfActivated, true);
  assert.equal(seq(w), 2);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(sentSeqs(w), [1, 2, 2]);
  assert.equal(seq(w), 2, 'recovery never moves the seq');
});

test('ensure: lost CAS with the row at 1 -> scheduled (our own just-sent seq 1 is a live copy); no extra send', async () => {
  const w = await prodAttempt({ schedule: false });
  // Between our SendMessage and our CAS, the seq 1 message (from an earlier ambiguous send) is
  // delivered and self-activates.
  w.queue.onSend = () => {
    payment(w).metadata = { ...(payment(w).metadata ?? {}), fastReconcileSeq: 1 };
  };
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'scheduled');
  assert.deepEqual(sentSeqs(w), [1]);
  assert.equal(seq(w), 1);
});

test('ensure: lost CAS with the row already past 1 -> recovery copy of the current link', async () => {
  const w = await prodAttempt({ schedule: false });
  clockAt(T0 + 40 * SEC);
  w.queue.onSend = (m) => {
    if (m.seq === 1) payment(w).metadata = { ...(payment(w).metadata ?? {}), fastReconcileSeq: 3 };
  };
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(w.queue.sent.map((x) => [x.message.seq, x.delaySeconds]), [[1, 3], [3, 0]]);
  assert.equal(seq(w), 3);
});

test('D. subsequent link crash: N+1 sent but CAS N -> N+1 never landed; N+1 self-activates and continues; the redelivered N is then stale', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 22 * SEC);
  await assert.rejects(
    () => fastReconcilePayment({ ...w.deps, db: casFails(w) }, { paymentId: w.paymentId, seq: 1 }),
    FastReconcileScheduleError,
  );
  assert.deepEqual(sentSeqs(w), [1, 2], 'link 2 is out');
  assert.equal(seq(w), 1, 'but the row still says 1');

  clockAt(T0 + 25 * SEC);
  const next = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 });
  assert.deepEqual(next, { result: 'requeued', paymentId: w.paymentId, nextDelaySeconds: 3, nextSeq: 3, selfActivated: true });
  assert.equal(seq(w), 3);

  const statusReads = w.provider.statusCalls.length;
  clockAt(T0 + 60 * SEC); // SQS redelivers seq 1 (its invocation threw)
  assert.equal((await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 })).result, 'stale_message');
  assert.equal(w.provider.statusCalls.length, statusReads, 'no provider call for the stale link');
  assert.deepEqual(sentSeqs(w), [1, 2, 3]);
});

test('E. duplicate N+1 (sequential): the first self-activates, the second is stale — one logical chain', async () => {
  const w = await prodAttempt();
  // Row at 1; two copies of seq 2 are in flight (e.g. the seq 1 worker sent, crashed before its
  // CAS, was redelivered and sent again).
  w.queue.sent.push({ message: { paymentId: w.paymentId, seq: 2 }, delaySeconds: 3 }, { message: { paymentId: w.paymentId, seq: 2 }, delaySeconds: 3 });
  clockAt(T0 + 25 * SEC);
  const first = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 });
  const second = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 });
  assert.equal(first.result, 'requeued');
  assert.equal(first.selfActivated, true);
  assert.equal(second.result, 'stale_message');
  assert.equal(w.provider.statusCalls.length, 1);
  assert.deepEqual(sentSeqs(w), [1, 2, 2, 3]);
  assert.equal(seq(w), 3);
});

test('E. duplicate N+1 (concurrent): exactly one activation, exactly one recorded next link, the sequence never forks', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 25 * SEC);
  const other: FastReconcileDeps = { ...w.deps, db: createFakePaymentDbClient(w.store) };
  const results = await Promise.all([
    fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 }),
    fastReconcilePayment(other, { paymentId: w.paymentId, seq: 2 }),
  ]);
  assert.equal(results.filter((r) => r.selfActivated).length, 1, 'only one copy performs the 1 -> 2 activation');
  assert.equal(results.filter((r) => r.result === 'requeued').length, 1, 'only one copy records 2 -> 3');
  assert.ok(results.every((r) => ['requeued', 'superseded', 'stale_message'].includes(r.result)), results.map((r) => r.result).join());
  assert.ok(w.provider.statusCalls.length <= 2, 'at most a duplicated status read');
  assert.ok(sentSeqs(w).slice(1).every((s) => s === 3), sentSeqs(w).join());
  assert.equal(seq(w), 3);
});

test('F. gap: row seq 1 + message seq 3 throws a consistency error (retry/DLQ) — never silently acknowledged, nothing touched', async () => {
  const w = await prodAttempt();
  clockAt(T0 + 25 * SEC);
  await assert.rejects(() => fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 3 }), FastReconcileConsistencyError);
  assert.equal(w.providerCalls.count, 0);
  assert.equal(w.provider.statusCalls.length, 0);
  assert.deepEqual(sentSeqs(w), [1]);
  assert.equal(seq(w), 1);
});

test('self-activation never happens for a closed attempt: a terminal row acknowledges seq N+1 without advancing', async () => {
  const w = await prodAttempt();
  await markPaymentPaid(w.db, w.paymentId, 'TX-EARLIER');
  const result = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 });
  assert.equal(result.result, 'terminal');
  assert.equal(seq(w), 1);
  assert.equal(w.providerCalls.count, 0);
});

// ------------------------------------------------------------------ sequential delivery

const deliveredIndexes = new WeakMap<World, Set<number>>();
const deliveredOf = (w: World) => {
  let set = deliveredIndexes.get(w);
  if (!set) deliveredIndexes.set(w, (set = new Set()));
  return set;
};

/** Delivers the queued messages ONE AT A TIME, earliest due first, until `untilMs` — the common
 *  case of duplicates that don't overlap in time. (Concurrent copies are covered separately: they
 *  may duplicate a status read, but never fork the sequence.) */
async function drainSerially(w: World, untilMs: number): Promise<{ seq: number; result: string }[]> {
  const delivered = deliveredOf(w);
  const out: { seq: number; result: string }[] = [];
  for (;;) {
    let next = -1;
    let nextDue = Infinity;
    w.queue.sent.forEach((entry, i) => {
      const due = w.queue.sentAtMs[i] + entry.delaySeconds * SEC;
      if (!delivered.has(i) && due <= untilMs && due < nextDue) {
        next = i;
        nextDue = due;
      }
    });
    if (next < 0) return out;
    delivered.add(next);
    clockAt(nextDue);
    const message = w.queue.sent[next].message;
    out.push({ seq: message.seq, result: (await fastReconcilePayment(w.deps, message)).result });
  }
}

/** Drop every undelivered message — a chain whose live link was lost / dead-lettered. */
function loseInFlight(w: World): void {
  w.queue.sent.forEach((_, i) => deliveredOf(w).add(i));
}

/** Each seq was sent at most once from `fromIndex` on — no duplicate is travelling down the chain. */
function assertNoDuplicateLinksFrom(w: World, fromIndex: number): void {
  const seqs = sentSeqs(w).slice(fromIndex);
  assert.deepEqual(seqs, [...new Set(seqs)], `duplicate links: ${seqs.join()}`);
}

test('sequential duplicate delivery: the second seq N copy is stale — provider called once for the pair, one N+1, no duplicate downstream', async () => {
  const w = await prodAttempt();
  await w.queue.send({ paymentId: w.paymentId, seq: 1 }, 22); // SQS at-least-once: a second copy of link 1
  const deliveries = await drainSerially(w, T0 + 60 * SEC);
  assert.deepEqual(deliveries.slice(0, 2), [{ seq: 1, result: 'requeued' }, { seq: 1, result: 'stale_message' }]);
  assert.equal(deliveries.filter((d) => d.result === 'stale_message').length, 1, 'only that one copy was ever stale');
  assert.equal(w.provider.statusCalls.length, deliveries.length - 1, 'one status read per live link');
  assert.equal(sentSeqs(w).filter((s) => s === 2).length, 1, 'only one seq 2 survives');
  assertNoDuplicateLinksFrom(w, 2);
});

test('sequential delivery: ambiguous first send + customer retry (two seq 1 copies) -> one live chain, no duplicate downstream', async () => {
  const w = await prodAttempt({ schedule: false });
  w.queue.ambiguousError = new Error('TimeoutError');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  w.queue.ambiguousError = undefined;
  clockAt(T0 + 3 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'scheduled');
  assert.deepEqual(sentSeqs(w), [1, 1]);

  const deliveries = await drainSerially(w, T0 + 60 * SEC);
  assert.equal(deliveries[0].result, 'requeued');
  assert.equal(deliveries[1].result, 'stale_message');
  assert.equal(deliveries.filter((d) => d.result === 'stale_message').length, 1);
  assert.equal(w.provider.statusCalls.length, deliveries.length - 1);
  assertNoDuplicateLinksFrom(w, 2);
});

// ------------------------------------------------------------------ dead-chain recovery (payment start)

/** A PRODUCTION attempt whose chain has run to seq 4 (t=31s) with link 4 still in flight. */
async function chainAtSeq4(): Promise<World> {
  const w = await prodAttempt();
  await drainSerially(w, T0 + 30 * SEC); // links 1..3 at t=22/25/28; link 4 due at t=31
  assert.equal(seq(w), 4);
  assert.deepEqual(sentSeqs(w), [1, 2, 3, 4]);
  return w;
}

test('A/D. dead chain (seq 4, its message dead-lettered): recovery sends { seq: 4 } with delay 0 and the chain resumes at 4 -> 5', async () => {
  const w = await chainAtSeq4();
  loseInFlight(w); // link 4 failed 5 times -> DLQ; nothing is live
  clockAt(T0 + 60 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(w.queue.sent.at(-1), { message: { paymentId: w.paymentId, seq: 4 }, delaySeconds: 0 });
  assert.equal(seq(w), 4, 'recovery never moves the seq');
  assert.equal(w.provider.createCalls.length, 1, 'no second PhonePe order');

  const statusReadsBefore = w.provider.statusCalls.length;
  const deliveries = await drainSerially(w, T0 + 70 * SEC);
  assert.deepEqual(deliveries.slice(0, 2), [{ seq: 4, result: 'requeued' }, { seq: 5, result: 'requeued' }]);
  assert.equal(w.provider.statusCalls.length, statusReadsBefore + deliveries.length);
  assert.ok(seq(w)! >= 6);
});

test('B. recovery send failure: throws, seq stays 4, same order; a later retry recovers', async () => {
  const w = await chainAtSeq4();
  loseInFlight(w);
  clockAt(T0 + 60 * SEC);
  w.queue.sendError = new Error('ServiceUnavailable');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  assert.equal(seq(w), 4);
  assert.equal(payment(w).provider_order_id, 'ord-prod-1');
  assert.deepEqual(sentSeqs(w), [1, 2, 3, 4]);

  w.queue.sendError = undefined;
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(sentSeqs(w), [1, 2, 3, 4, 4]);
});

test('C. healthy chain + recovery duplicate, delivered sequentially: the pair costs one status read and yields one seq 5', async () => {
  const w = await chainAtSeq4(); // link 4 is live, due at t=31
  clockAt(T0 + 30 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled'); // due at t=30
  const statusReadsBefore = w.provider.statusCalls.length;
  const deliveries = await drainSerially(w, T0 + 32 * SEC);
  assert.deepEqual(deliveries, [{ seq: 4, result: 'requeued' }, { seq: 4, result: 'stale_message' }]);
  assert.equal(w.provider.statusCalls.length, statusReadsBefore + 1, 'one status read for the pair');
  assert.equal(sentSeqs(w).filter((s) => s === 5).length, 1, 'one live seq 5');
  assert.equal(seq(w), 5);
  await drainSerially(w, T0 + 90 * SEC);
  assertNoDuplicateLinksFrom(w, 5);
});

test('E. ambiguous recovery send: 503-worthy throw with seq 4 kept; the delivered copy reconciles; a retry\'s second 4 is stale; no multiplication', async () => {
  const w = await chainAtSeq4();
  loseInFlight(w);
  clockAt(T0 + 60 * SEC);
  w.queue.ambiguousError = new Error('TimeoutError');
  await assert.rejects(() => ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), FastReconcileScheduleError);
  assert.equal(seq(w), 4);
  w.queue.ambiguousError = undefined;
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  assert.deepEqual(sentSeqs(w).slice(4), [4, 4]);

  const statusReadsBefore = w.provider.statusCalls.length;
  const deliveries = await drainSerially(w, T0 + 120 * SEC);
  assert.deepEqual(deliveries.slice(0, 2), [{ seq: 4, result: 'requeued' }, { seq: 4, result: 'stale_message' }]);
  assert.equal(deliveries.filter((d) => d.result === 'stale_message').length, 1);
  assert.equal(w.provider.statusCalls.length, statusReadsBefore + deliveries.length - 1);
  assertNoDuplicateLinksFrom(w, 6);
});

test('recovery copy delivered after the payment went terminal: acknowledged, no provider call, nothing sent', async () => {
  const w = await chainAtSeq4();
  loseInFlight(w);
  clockAt(T0 + 60 * SEC);
  assert.equal(await ensureFastReconcileScheduled(w.db, w.queue, w.paymentId), 'recovery_scheduled');
  await markPaymentPaid(w.db, w.paymentId, 'TX-WEBHOOK');
  const statusReadsBefore = w.provider.statusCalls.length;
  assert.deepEqual(await drainSerially(w, T0 + 70 * SEC), [{ seq: 4, result: 'terminal' }]);
  assert.equal(w.provider.statusCalls.length, statusReadsBefore);
  assert.deepEqual(sentSeqs(w), [1, 2, 3, 4, 4]);
});

// ------------------------------------------------------------------ concurrent duplicate delivery (no serialization)

test('concurrent: a recovery copy racing the live seq 4 — one logical advance to 5, at most a duplicated status read, never a fork', async () => {
  const w = await chainAtSeq4();
  clockAt(T0 + 31 * SEC);
  const other: FastReconcileDeps = { ...w.deps, db: createFakePaymentDbClient(w.store) };
  const statusReadsBefore = w.provider.statusCalls.length;
  const sentBefore = w.queue.sent.length;
  const results = await Promise.all([
    fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 4 }),
    fastReconcilePayment(other, { paymentId: w.paymentId, seq: 4 }),
  ]);
  assert.equal(results.filter((r) => r.result === 'requeued').length, 1, 'exactly one copy records 4 -> 5');
  assert.ok(results.every((r) => ['requeued', 'superseded', 'stale_message'].includes(r.result)), results.map((r) => r.result).join());
  assert.ok(w.provider.statusCalls.length - statusReadsBefore <= 2, 'bounded duplicate read');
  assert.ok(sentSeqs(w).slice(sentBefore).every((s) => s === 5), 'any extra message is a same-seq 5 duplicate');
  assert.equal(seq(w), 5);
  assert.equal(payment(w).payment_status, 'pending');
});

test('concurrent: two copies of the live link seeing COMPLETED — paid once, confirmed once, terminal stays terminal, no follow-up', async () => {
  const w = await prodAttempt();
  w.provider.statuses.set('ord-prod-1', success);
  clockAt(T0 + 22 * SEC);
  const other: FastReconcileDeps = { ...w.deps, db: createFakePaymentDbClient(w.store) };
  const results = await Promise.all([
    fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 1 }),
    fastReconcilePayment(other, { paymentId: w.paymentId, seq: 1 }),
  ]);
  assert.ok(results.some((r) => r.result === 'confirmed'), results.map((r) => r.result).join());
  assert.ok(results.every((r) => ['confirmed', 'terminal'].includes(r.result)), results.map((r) => r.result).join());
  assert.equal(w.store.payments.filter((p) => p.payment_status === 'paid').length, 1);
  assert.equal(w.store.allocations.filter((a) => a.allocation_status === 'confirmed').length, 1);
  assert.equal(w.store.bookings.find((b) => b.id === w.bookingId)?.status, 'confirmed');
  assert.deepEqual(sentSeqs(w), [1], 'no follow-up link');

  const late = await fastReconcilePayment(w.deps, { paymentId: w.paymentId, seq: 2 });
  assert.equal(late.result, 'terminal', 'a later/recovery copy never reopens it');
  assert.equal(payment(w).payment_status, 'paid');
});
