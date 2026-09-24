// PhonePe cutover Stage 2B: PRODUCTION fast payment reconciliation — PhonePe's mandatory PENDING
// status-check cadence (production-reconcile-schedule.ts), driven by a self-rescheduling chain of
// delayed SQS messages, one chain per open PRODUCTION attempt.
//
// This module owns only the CHAIN: which row a message is about, whether that message is still the
// current link, and when/whether to schedule the next one. Every payment state transition still
// goes through reconcilePayment() -> applyProviderOutcome() -> confirmSuccessfulPayment() — the
// exact path the status endpoint and the 5-minute reconcilers use. There is no second state
// machine here.
//
// TRUST: an SQS message carries only { paymentId, seq }. The PRODUCTION environment is a constant
// of this module, re-checked against the typed payments.payment_environment column and against the
// environment the provider's own secret declares. Nothing in a message can select an environment,
// a provider order, an amount or a status.
//
// SEQUENCE PROTOCOL (send first, receiver self-activates). The attempt's metadata.fastReconcileSeq
// is the chain's live link. INVARIANT: it only ever moves forward, one step at a time
// (advanceFastReconcileSeq), and only for a sequence whose message was already SENT successfully
// or has actually been RECEIVED. So seq > 0 proves a message for that seq exists; there is never
// a "DB says scheduled, nothing in flight" state and nothing is ever rolled back.
//
//   Scheduling seq N+1 (payment start: N = 0; a worker: N = its own seq):
//     1. SendMessage { paymentId, seq: N+1 }. Throws -> FastReconcileScheduleError, the DB is
//        untouched, and the retry (SQS redelivery / customer retry) simply sends N+1 again.
//     2. Then CAS N -> N+1. Losing the race is harmless (another caller or the delivered message
//        itself already advanced it). If this process dies between 1 and 2, step 3 repairs it.
//   Receiving seq M (row currently at C):
//     C == M     the live link: process it.
//     C == M-1   the sender's CAS never landed (crash / DB error / ambiguous SQS error after the
//                message was actually enqueued): the message itself activates C -> M, then is
//                processed. Only one concurrent copy wins that CAS; a loser re-reads and treats
//                the row like any other delivery.
//     C >  M     an older/duplicate link: acknowledged, no provider call.
//     C <  M-1   impossible under the invariant: FastReconcileConsistencyError (SQS retry -> DLQ
//                -> alarm), never silently acknowledged.
//
// DUPLICATES: Standard SQS is at-least-once, a send whose outcome is ambiguous may be retried, and
// payment start sends recovery copies of the current link (ensureFastReconcileScheduled) that may
// duplicate a message that is still live. So several deliveries can carry the same seq, and they
// may run concurrently (the worker has no reserved concurrency). They are still one LOGICAL
// chain: the M -> M+1 CAS succeeds at most once, so exactly one logical next link is ever
// activated and the sequence never forks or goes backwards. A copy of M delivered after M -> M+1
// was recorded is stale (no provider call, nothing sent). In the rare race where two copies of M
// run at the same time, both may read PhonePe's status (a bounded duplicate read) and both may
// send M+1; only one records it, and every payment state transition stays idempotent.
// TODO (after launch): add a per-payment processing lease/idempotency mechanism if duplicate
// provider status reads ever become operationally significant.
//
// FAILURES: anything unexpected (DB, PhonePe, SQS, configuration, consistency) THROWS. For the
// worker that means SQS redelivers the same message after its visibility timeout, and after
// maxReceiveCount it lands in the DLQ (alarmed). For payment start it means the handler refuses to
// hand out the checkout redirect, and a retry reuses the same open attempt (no second PhonePe
// order) and sends the first link then.

import type { DbClient } from './allocate-simulators';
import { storedEnvironmentMatches, type AppEnvironment } from './environment';
import type { PaymentProviderAdapter } from './payment-provider';
import { advanceFastReconcileSeq, findPaymentById, mergePaymentMetadata, type PaymentRow } from './payment-repository';
import { FIRST_CHECK_DELAY_SECONDS, getNextProductionReconcileDelay } from './production-reconcile-schedule';
import type { FastReconcileMessage, ReconcileQueue } from './reconcile-queue';
import { reconcilePayment } from './reconcile-payment';

/** The only environment the fast chain exists for — a code constant, never configuration. */
export const FAST_RECONCILE_ENVIRONMENT: AppEnvironment = 'PRODUCTION';

/** Scheduling a link failed: SendMessage failed (SQS unavailable/denied/misconfigured — possibly
 *  after actually enqueueing), or it succeeded but recording the advance failed. Either way the
 *  sequence was not advanced by this caller. Deliberately NOT a PaymentDomainError: it is a
 *  server-side fault, never mapped to a 4xx. */
export class FastReconcileScheduleError extends Error {
  readonly name = 'FastReconcileScheduleError';
  readonly code = 'fast_reconcile_schedule_failed';
}

/** A delivered seq is more than one ahead of the row's — impossible under the send-first
 *  invariant. Thrown (never acknowledged) so the message is retried and, if it persists,
 *  dead-lettered and alarmed. */
export class FastReconcileConsistencyError extends Error {
  readonly name = 'FastReconcileConsistencyError';
}

export type FastReconcileItemResult =
  | 'unknown_payment'
  | 'environment_mismatch'
  | 'not_phonepe'
  | 'terminal'
  | 'stale_message'
  | 'no_live_order'
  | 'confirmed'
  | 'paid_refund_required'
  | 'failed'
  | 'expired'
  | 'requeued'
  | 'superseded'
  | 'fast_window_ended';

export interface FastReconcileRunResult {
  result: FastReconcileItemResult;
  paymentId: string;
  /** Present only for 'requeued'. */
  nextDelaySeconds?: number;
  nextSeq?: number;
  /** This delivery advanced the row to its own seq (the sender's CAS had not landed). */
  selfActivated?: true;
}

const OPEN_STATUSES = new Set(['created', 'pending']);

function metadataDate(payment: PaymentRow, key: string): Date | undefined {
  const raw = payment.metadata?.[key];
  if (typeof raw !== 'string') return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function fastReconcileSeqOf(payment: PaymentRow): number {
  const raw = payment.metadata?.fastReconcileSeq;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : 0;
}

function hasLiveOrder(payment: PaymentRow): boolean {
  const checkout = payment.metadata?.checkout as { redirectUrl?: unknown } | undefined;
  return typeof checkout?.redirectUrl === 'string' && checkout.redirectUrl.length > 0;
}

/** When the fast cadence is measured from: the moment the provider order was acknowledged
 *  (metadata.paymentInitiatedAt, written in start-payment's TX2), else the row's own created_at. */
export function initiatedAtOf(payment: PaymentRow): Date {
  return metadataDate(payment, 'paymentInitiatedAt') ?? new Date(payment.created_at);
}

/** Where the fast cadence stops: the provider's own reported expiry, else the expiry we asked the
 *  provider for (metadata.orderExpiresAt). Neither -> undefined -> no fast check is scheduled. */
export function fastReconcileDeadlineOf(payment: PaymentRow): Date | undefined {
  return metadataDate(payment, 'providerExpiresAt') ?? metadataDate(payment, 'orderExpiresAt');
}

/** Send link `fromSeq + 1`, THEN record it (CAS fromSeq -> fromSeq + 1). A send failure throws
 *  FastReconcileScheduleError with the sequence untouched (nothing to roll back; a retry sends
 *  the same seq again). `recorded: false` means the CAS matched nothing — another caller, or the
 *  delivered message itself, already advanced the row (or the attempt closed); the message we sent
 *  is then a harmless duplicate. If the CAS itself errors, the message still exists and will
 *  self-activate on delivery; we throw so the caller does not proceed as if the advance were
 *  recorded. */
async function scheduleNextLink(
  db: DbClient,
  queue: ReconcileQueue,
  paymentId: string,
  fromSeq: number,
  delaySeconds: number,
): Promise<{ seq: number; recorded: boolean }> {
  const nextSeq = fromSeq + 1;
  try {
    await queue.send({ paymentId, seq: nextSeq }, delaySeconds);
  } catch (err) {
    throw new FastReconcileScheduleError(
      `Could not schedule fast reconciliation (${err instanceof Error ? err.name : 'unknown'})`,
    );
  }
  let recorded: boolean;
  try {
    recorded = await advanceFastReconcileSeq(db, paymentId, fromSeq);
  } catch (err) {
    throw new FastReconcileScheduleError(
      `Fast reconciliation link sent but not recorded (${err instanceof Error ? err.name : 'unknown'})`,
    );
  }
  return { seq: nextSeq, recorded };
}

/** 'scheduled' / 'recovery_scheduled' are the only results that prove a message for the attempt's
 *  current seq was just sent successfully — the only ones payment start may hand a redirect out on. */
export type EnsureScheduledResult = 'scheduled' | 'recovery_scheduled' | 'not_open' | 'fast_window_ended';

/**
 * Payment start (PRODUCTION only): make sure the attempt it is about to hand to the customer has a
 * LIVE fast chain, proven by a SendMessage that succeeded during this call.
 *
 *   seq == 0  (fresh attempt, or the earlier first send failed / its CAS never landed): send link 1
 *             at the delay the schedule gives for the attempt's real age (so a late start never
 *             "restarts" the cadence), then record 0 -> 1 -> 'scheduled'.
 *   seq  > 0  that seq proves a message was once sent or received, NOT that the chain is still
 *             alive (its message may have dead-lettered). So send a RECOVERY copy of the CURRENT
 *             link { paymentId, seq } -> 'recovery_scheduled'. The seq is NOT touched. The copy
 *             carries no authority beyond the seq comparison: if the chain is healthy, whichever
 *             copy of that seq delivered after the other has advanced the chain is stale (a
 *             rare concurrent pair may both read the status — harmless); if the chain died,
 *             the copy revives it; if the attempt is terminal by then, it is acknowledged.
 *             Delay 0 (the chain may be overdue) — except before the first check is due (t < 22s),
 *             where it waits for t = 22s so a recovery never checks earlier than PhonePe's cadence.
 *
 * Any send failure throws FastReconcileScheduleError; payment start must then refuse the redirect,
 * as it must for 'not_open' / 'fast_window_ended'.
 */
export async function ensureFastReconcileScheduled(
  db: DbClient,
  queue: ReconcileQueue,
  paymentId: string,
  now: Date = new Date(),
): Promise<EnsureScheduledResult> {
  const payment = await findPaymentById(db, paymentId);
  if (!payment || !OPEN_STATUSES.has(payment.payment_status)) {
    return 'not_open';
  }
  if (!storedEnvironmentMatches(payment.payment_environment, FAST_RECONCILE_ENVIRONMENT)) {
    // Callers only use this for PRODUCTION attempts; refuse rather than chain any other row.
    throw new Error('ensureFastReconcileScheduled: not a PRODUCTION payment attempt');
  }
  const initiatedAt = initiatedAtOf(payment);
  const delay = getNextProductionReconcileDelay({ initiatedAt, now, expiresAt: fastReconcileDeadlineOf(payment) });
  if (delay === null) {
    return 'fast_window_ended';
  }
  const beforeFirstCheck = now.getTime() - initiatedAt.getTime() < FIRST_CHECK_DELAY_SECONDS * 1000;
  const recoveryDelay = beforeFirstCheck ? delay : 0;

  const current = fastReconcileSeqOf(payment);
  if (current > 0) {
    await sendRecovery(queue, paymentId, current, recoveryDelay);
    return 'recovery_scheduled';
  }
  const link = await scheduleNextLink(db, queue, paymentId, 0, delay);
  if (link.recorded) {
    return 'scheduled';
  }
  // Our seq 1 message is out, but the row moved first (a concurrent start, or seq 1 already
  // delivered and self-activated) — or the attempt closed.
  const reloaded = await findPaymentById(db, paymentId);
  if (!reloaded || !OPEN_STATUSES.has(reloaded.payment_status)) {
    return 'not_open';
  }
  const latest = fastReconcileSeqOf(reloaded);
  if (latest === 1) {
    // The seq 1 message we just sent successfully is itself a live copy of the current link.
    return 'scheduled';
  }
  if (latest > 1) {
    await sendRecovery(queue, paymentId, latest, recoveryDelay);
    return 'recovery_scheduled';
  }
  throw new FastReconcileConsistencyError('ensureFastReconcileScheduled: advance from seq 0 matched no open row');
}

/** A recovery copy of the CURRENT link. Never changes fastReconcileSeq. */
async function sendRecovery(queue: ReconcileQueue, paymentId: string, seq: number, delaySeconds: number): Promise<void> {
  try {
    await queue.send({ paymentId, seq }, delaySeconds);
  } catch (err) {
    throw new FastReconcileScheduleError(
      `Could not send fast reconciliation recovery (${err instanceof Error ? err.name : 'unknown'})`,
    );
  }
}

type LinkState = { state: 'active'; payment: PaymentRow; selfActivated: boolean } | { state: 'stale' } | { state: 'closed' };

/** Decide what delivery `seq` is relative to the row (see SEQUENCE PROTOCOL above), activating it
 *  when the sender's CAS never landed. */
async function resolveLink(db: DbClient, payment: PaymentRow, seq: number): Promise<LinkState> {
  const current = fastReconcileSeqOf(payment);
  if (current === seq) {
    return { state: 'active', payment, selfActivated: false };
  }
  if (current > seq) {
    return { state: 'stale' };
  }
  if (current === seq - 1) {
    if (await advanceFastReconcileSeq(db, payment.id, current)) {
      return { state: 'active', payment: { ...payment, metadata: { ...(payment.metadata ?? {}), fastReconcileSeq: seq } }, selfActivated: true };
    }
    // Lost the activation race (a concurrent copy of this seq, or the sender's own CAS) or the
    // attempt closed: re-read and evaluate again, without another activation attempt.
    const reloaded = await findPaymentById(db, payment.id);
    if (!reloaded || !OPEN_STATUSES.has(reloaded.payment_status)) {
      return { state: 'closed' };
    }
    const latest = fastReconcileSeqOf(reloaded);
    if (latest === seq) {
      return { state: 'active', payment: reloaded, selfActivated: false };
    }
    if (latest > seq) {
      return { state: 'stale' };
    }
  }
  throw new FastReconcileConsistencyError(
    `Fast reconcile message seq ${seq} does not follow the recorded seq ${fastReconcileSeqOf(payment)}`,
  );
}

export interface FastReconcileDeps {
  db: DbClient;
  /** Loaded only once a message is known to need a provider check. */
  getProvider: () => Promise<PaymentProviderAdapter & { environment: AppEnvironment }>;
  queue: ReconcileQueue;
  now?: () => Date;
}

/**
 * One fast-chain link. Returns a result for every expected situation (all of which acknowledge the
 * message); THROWS for unexpected provider/DB/queue/configuration failures so SQS retries the same
 * message (and eventually dead-letters it). Never schedules a next link when it throws.
 */
export async function fastReconcilePayment(
  deps: FastReconcileDeps,
  message: FastReconcileMessage,
): Promise<FastReconcileRunResult> {
  const { db, queue } = deps;
  const now = deps.now ?? (() => new Date());
  const paymentId = message.paymentId;

  const loaded = await findPaymentById(db, paymentId);
  if (!loaded) {
    return { result: 'unknown_payment', paymentId };
  }
  if (!storedEnvironmentMatches(loaded.payment_environment, FAST_RECONCILE_ENVIRONMENT)) {
    return { result: 'environment_mismatch', paymentId };
  }
  if (loaded.provider !== 'phonepe') {
    return { result: 'not_phonepe', paymentId };
  }
  if (!OPEN_STATUSES.has(loaded.payment_status)) {
    return { result: 'terminal', paymentId };
  }
  const link = await resolveLink(db, loaded, message.seq);
  if (link.state === 'stale') {
    return { result: 'stale_message', paymentId };
  }
  if (link.state === 'closed') {
    return { result: 'terminal', paymentId };
  }
  const payment = link.payment;
  const activated = link.selfActivated ? { selfActivated: true as const } : {};
  if (!hasLiveOrder(payment)) {
    // Never scheduled for such a row; if it somehow is, there is no provider order to ask about yet.
    return { result: 'no_live_order', paymentId, ...activated };
  }

  const provider = await deps.getProvider();
  if (provider.environment !== FAST_RECONCILE_ENVIRONMENT) {
    throw new Error(`Fast reconciler provider is configured for ${String(provider.environment)}, not ${FAST_RECONCILE_ENVIRONMENT}`);
  }

  const { applied, providerExpiresAt } = await reconcilePayment(db, provider, payment.provider_order_id);

  // Bookkeeping: rotate this attempt to the back of the 5-minute fallback's queue, and backfill the
  // provider's expiry if start-payment didn't get one.
  const patch: Record<string, unknown> = { reconcileCheckedAt: now().toISOString() };
  if (providerExpiresAt && !metadataDate(payment, 'providerExpiresAt')) {
    patch.providerExpiresAt = providerExpiresAt.toISOString();
  }
  await mergePaymentMetadata(db, paymentId, patch);

  switch (applied.status) {
    case 'confirmed':
      return { result: 'confirmed', paymentId, ...activated };
    case 'paid_refund_required':
      return { result: 'paid_refund_required', paymentId, ...activated };
    case 'failed':
      return { result: 'failed', paymentId, ...activated };
    case 'expired':
      return { result: 'expired', paymentId, ...activated };
    case 'pending':
      break;
  }

  const deadline =
    metadataDate(payment, 'providerExpiresAt') ?? providerExpiresAt ?? metadataDate(payment, 'orderExpiresAt');
  const delay = getNextProductionReconcileDelay({ initiatedAt: initiatedAtOf(payment), now: now(), expiresAt: deadline });
  if (delay === null) {
    return { result: 'fast_window_ended', paymentId, ...activated };
  }
  const next = await scheduleNextLink(db, queue, paymentId, message.seq, delay);
  if (!next.recorded) {
    // Our next link is out, but the row already moved past this seq (a concurrent copy of this
    // link, or that next link was already delivered and self-activated) or closed. The message we
    // sent is a same-seq duplicate; only one copy can ever activate the next step.
    return { result: 'superseded', paymentId, ...activated };
  }
  return { result: 'requeued', paymentId, nextDelaySeconds: delay, nextSeq: next.seq, ...activated };
}
