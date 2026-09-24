import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIRST_CHECK_DELAY_SECONDS,
  cadenceDelaySeconds,
  getNextProductionReconcileDelay,
} from './production-reconcile-schedule';

const T0 = new Date(Date.UTC(2026, 8, 25, 6, 0, 0));
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
/** A generous expiry so only the cadence table matters. */
const FAR = at(20 * 60);

const delayAt = (elapsed: number, expiresAt: Date | null | undefined = FAR) =>
  getNextProductionReconcileDelay({ initiatedAt: T0, now: at(elapsed), expiresAt });

test('first check is 22 seconds after initiation', () => {
  assert.equal(FIRST_CHECK_DELAY_SECONDS, 22);
  assert.equal(delayAt(0), 22);
  // Asked early (e.g. a retried start scheduling late): only the time left until t=22.
  assert.equal(delayAt(10), 12);
  assert.equal(delayAt(21.2), 1);
  assert.equal(delayAt(21.999), 1);
});

test('cadence boundaries: 22 / 52 / 112 / 172 / 232 seconds', () => {
  const expectations: [number, number][] = [
    [22, 3], [25, 3], [51, 3], [51.999, 3],
    [52, 6], [111.999, 6],
    [112, 10], [171.999, 10],
    [172, 30], [231.999, 30],
    [232, 60], [300, 60], [1000, 60],
  ];
  for (const [elapsed, delay] of expectations) {
    assert.equal(delayAt(elapsed), delay, `elapsed ${elapsed}s`);
    assert.equal(cadenceDelaySeconds(elapsed), delay, `table at ${elapsed}s`);
  }
});

test('walking the chain from t=0 reproduces PhonePe\'s schedule exactly', () => {
  const checks: number[] = [];
  let t = 0;
  for (;;) {
    const delay = delayAt(t, at(400));
    if (delay === null) break;
    t += delay;
    checks.push(t);
  }
  assert.deepEqual(checks.slice(0, 11), [22, 25, 28, 31, 34, 37, 40, 43, 46, 49, 52]);
  // 6s cadence for the next 60s, 10s for 60s, 30s for 60s, then 60s.
  assert.deepEqual(checks.slice(10, 21), [52, 58, 64, 70, 76, 82, 88, 94, 100, 106, 112]);
  assert.deepEqual(checks.slice(20, 27), [112, 122, 132, 142, 152, 162, 172]);
  assert.deepEqual(checks.slice(26, 29), [172, 202, 232]);
  assert.deepEqual(checks.slice(28), [232, 292, 352, 400], 'the last check is truncated to the expiry boundary, then the chain stops');
});

test('expiry truncation: never scheduled past the provider expiry; the final check lands at the boundary', () => {
  assert.equal(delayAt(300, at(330)), 30, '60s normal, only 30s left');
  assert.equal(delayAt(40, at(41)), 1);
  assert.equal(delayAt(40, at(40.2)), 1, 'rounded UP onto the boundary, never before it');
  assert.equal(delayAt(0, at(10)), 10, 'even the first check is not scheduled past expiry');
  assert.equal(delayAt(232, at(292)), 60, 'exactly one normal interval left');
});

test('expiry reached (or passed) stops the fast chain', () => {
  assert.equal(delayAt(400, at(400)), null);
  assert.equal(delayAt(401, at(400)), null);
  assert.equal(delayAt(30, at(29.999)), null);
});

test('no trustworthy expiry or clock value -> no fast check is scheduled', () => {
  assert.equal(delayAt(30, null), null);
  assert.equal(getNextProductionReconcileDelay({ initiatedAt: T0, now: at(30), expiresAt: undefined }), null);
  assert.equal(delayAt(30, new Date(Number.NaN)), null);
  assert.equal(getNextProductionReconcileDelay({ initiatedAt: new Date(Number.NaN), now: at(30), expiresAt: FAR }), null);
});

test('clock skew (now before initiation) is treated as elapsed 0, not a negative delay', () => {
  assert.equal(delayAt(-5), 22);
});
