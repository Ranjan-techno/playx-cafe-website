// In-memory ReconcileQueue for tests: records every send (message + delay) and can be told to fail.

import type { FastReconcileMessage, ReconcileQueue } from '../reconcile-queue';

export class FakeReconcileQueue implements ReconcileQueue {
  sent: { message: FastReconcileMessage; delaySeconds: number }[] = [];
  /** Date.now() at each entry of `sent` (same index) — lets a test deliver messages when due. */
  sentAtMs: number[] = [];
  /** Number of send() calls, including failed ones. */
  attempts = 0;
  /** When set, send() throws it (a function lets a test fail only some calls). */
  sendError?: Error | ((attempt: number) => Error | undefined);
  /** When set, send() ENQUEUES the message (it lands in `sent`) and then throws it anyway — an
   *  ambiguous SQS failure (e.g. a timeout after the service accepted the message). */
  ambiguousError?: Error;
  /** Runs at the start of every send() — for probing DB state at the moment of enqueue. */
  onSend?: (message: FastReconcileMessage) => void;

  async send(message: FastReconcileMessage, delaySeconds: number): Promise<void> {
    const attempt = this.attempts;
    this.attempts += 1;
    this.onSend?.(message);
    const failure = typeof this.sendError === 'function' ? this.sendError(attempt) : this.sendError;
    if (failure) {
      throw failure;
    }
    this.sent.push({ message: { ...message }, delaySeconds });
    this.sentAtMs.push(Date.now());
    if (this.ambiguousError) {
      throw this.ambiguousError;
    }
  }
}
