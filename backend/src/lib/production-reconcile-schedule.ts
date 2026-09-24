// PhonePe cutover Stage 2B: the mandatory PENDING-order status-check cadence for PRODUCTION
// payments, as a pure function (no clock, no I/O) so every boundary is unit-testable.
//
// PhonePe's schedule, measured from payment initiation (we use a deterministic 22s first check,
// inside PhonePe's 20-25s window):
//
//   t = 22s            first check
//   22s  <= t < 52s    every 3s   (30s)
//   52s  <= t < 112s   every 6s   (60s)
//   112s <= t < 172s   every 10s  (60s)
//   172s <= t < 232s   every 30s  (60s)
//   t >= 232s          every 60s  until terminal
//
// and the fast cadence stops at the provider order's expiry: no check is ever scheduled past it.
// When less than a normal interval remains, the last check lands on (just after) the expiry
// boundary; once the expiry has been reached the fast chain ends (null). The 5-minute PRODUCTION
// fallback reconciler still picks up anything left unresolved after that.
//
// "Initiation" is chosen by the caller (fast-reconcile-payment.ts's initiatedAtOf()): the attempt's
// metadata.paymentInitiatedAt (written in start-payment.ts's TX2 once the provider order was
// acknowledged), falling back to the row's own payments.created_at — database values, never
// anything from a request or an SQS message.

export const FIRST_CHECK_DELAY_SECONDS = 22;

/** [elapsed-seconds upper bound (exclusive), next delay in seconds] after the first check. */
const CADENCE: readonly (readonly [number, number])[] = [
  [52, 3],
  [112, 6],
  [172, 10],
  [232, 30],
];
const STEADY_STATE_DELAY_SECONDS = 60;

/** SQS DelaySeconds bounds (0-900). Every value this module returns is well inside them. */
export const MAX_SQS_DELAY_SECONDS = 900;

/** The cadence interval that applies once `elapsedSeconds` have passed since initiation (the
 *  schedule's own table, ignoring expiry). Before the first check is due, the time left until it. */
export function cadenceDelaySeconds(elapsedSeconds: number): number {
  if (elapsedSeconds < FIRST_CHECK_DELAY_SECONDS) {
    return Math.max(1, Math.ceil(FIRST_CHECK_DELAY_SECONDS - elapsedSeconds));
  }
  for (const [upTo, delay] of CADENCE) {
    if (elapsedSeconds < upTo) {
      return delay;
    }
  }
  return STEADY_STATE_DELAY_SECONDS;
}

export interface NextReconcileDelayInput {
  /** When the payment attempt was initiated (see initiatedAtOf()). */
  initiatedAt: Date;
  /** The current time (the caller's clock, injected for testability). */
  now: Date;
  /** When the provider order expires; null/undefined/invalid -> no fast check can be scheduled. */
  expiresAt: Date | null | undefined;
}

/**
 * Seconds until the next PRODUCTION fast status check, or null when the fast chain must stop
 * (the order's expiry has been reached, or no trustworthy expiry is known).
 *
 * Called with now == initiatedAt (elapsed 0) this is the initial 22s delay.
 */
export function getNextProductionReconcileDelay(input: NextReconcileDelayInput): number | null {
  const { initiatedAt, now, expiresAt } = input;
  if (!isValidDate(initiatedAt) || !isValidDate(now) || !isValidDate(expiresAt)) {
    return null;
  }
  const remainingMs = expiresAt.getTime() - now.getTime();
  if (remainingMs <= 0) {
    return null;
  }
  const elapsedSeconds = Math.max(0, (now.getTime() - initiatedAt.getTime()) / 1000);
  const normal = cadenceDelaySeconds(elapsedSeconds);
  // Round the remainder UP so the final check is delivered at/after the expiry boundary (and the
  // chain then ends), never a few hundred milliseconds before it (which would schedule a stray
  // 1-second follow-up).
  const untilExpiry = Math.ceil(remainingMs / 1000);
  return Math.min(normal, untilExpiry, MAX_SQS_DELAY_SECONDS);
}

function isValidDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
