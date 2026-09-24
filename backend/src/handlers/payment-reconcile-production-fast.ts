import type { SQSEvent } from 'aws-lambda';
import type { DbClient } from '../lib/allocate-simulators';
import { getDb, resetDb } from '../lib/db';
import type { AppEnvironment } from '../lib/environment';
import { fastReconcilePayment, type FastReconcileRunResult } from '../lib/fast-reconcile-payment';
import type { PaymentProviderAdapter } from '../lib/payment-provider';
import { getPhonePePaymentProvider } from '../lib/phonepe-runtime';
import { createSqsReconcileQueue, isValidQueueUrl, parseFastReconcileMessage, type ReconcileQueue } from '../lib/reconcile-queue';

// PhonePe cutover Stage 2B: playx-dev-payment-reconcile-production-fast — consumes the PRODUCTION
// fast-reconcile SQS queue (batch size 1). Each message is one link of an attempt's PhonePe
// status-check chain; see lib/fast-reconcile-payment.ts for the chain, duplicate handling and
// why every state change still goes through the shared reconcilePayment() path, and
// lib/production-reconcile-schedule.ts for the cadence.
//
// PRODUCTION only, by construction: the environment is a constant in fast-reconcile-payment.ts,
// checked against the payment row and against the environment the PhonePe secret itself declares.
// The Lambda's IAM role can read only the production PhonePe secret.
//
// ACK vs RETRY: a message that can never succeed (malformed body, unknown payment, wrong
// environment, already terminal, duplicate/superseded link) is acknowledged — logged, no provider
// call. An unexpected failure (DB, PhonePe, SQS, configuration) THROWS, so SQS redelivers the same
// message after the visibility timeout and, after maxReceiveCount, moves it to the DLQ (alarmed).
// A failed invocation never enqueues a follow-up itself.
//
// Logs only ids, results and error class names — never provider payloads, URLs or credentials.

export interface FastReconcileHandlerDeps {
  getDb: () => Promise<DbClient>;
  resetDb: () => void;
  getProvider: () => Promise<PaymentProviderAdapter & { environment: AppEnvironment }>;
  getQueue: (queueUrl: string) => ReconcileQueue;
  env: Record<string, string | undefined>;
  now?: () => Date;
}

const defaultDeps: FastReconcileHandlerDeps = {
  getDb,
  resetDb,
  getProvider: () => getPhonePePaymentProvider(),
  getQueue: createSqsReconcileQueue,
  env: process.env,
};

export function createHandler(deps: FastReconcileHandlerDeps = defaultDeps) {
  return async (event: SQSEvent): Promise<FastReconcileRunResult[]> => {
    const queueUrl = deps.env.PAYMENT_RECONCILE_QUEUE_URL;
    if (!isValidQueueUrl(queueUrl)) {
      // Can't continue a chain without the queue: fail (retry -> DLQ -> alarm) before any work.
      console.error('payment-reconcile-production-fast: PAYMENT_RECONCILE_QUEUE_URL is not configured');
      throw new Error('PAYMENT_RECONCILE_QUEUE_URL is not configured');
    }
    const queue = deps.getQueue(queueUrl);
    const results: FastReconcileRunResult[] = [];

    for (const record of event.Records ?? []) {
      const message = parseFastReconcileMessage(record.body);
      if (!message) {
        console.error('payment-reconcile-production-fast: malformed message acknowledged', JSON.stringify({ messageId: record.messageId }));
        continue;
      }
      try {
        const db = await deps.getDb();
        const result = await fastReconcilePayment({ db, getProvider: deps.getProvider, queue, now: deps.now }, message);
        results.push(result);
        const log = ['unknown_payment', 'environment_mismatch', 'not_phonepe'].includes(result.result) ? console.error : console.log;
        log('payment-reconcile-production-fast', JSON.stringify({ messageId: record.messageId, ...result }));
      } catch (err) {
        deps.resetDb();
        console.error(
          'payment-reconcile-production-fast failed',
          JSON.stringify({ messageId: record.messageId, paymentId: message.paymentId, error: err instanceof Error ? err.name : 'unknown' }),
        );
        throw err;
      }
    }
    return results;
  };
}

export const handler = createHandler();
