// PhonePe cutover Stage 2B: the PRODUCTION fast-reconciliation SQS message and the one queue call
// the backend makes (SendMessage with a delay). Behind an interface so the domain logic and its
// tests never touch the AWS SDK; the real client is created lazily, only by a caller that has
// actually passed its kill switch and configuration checks.
//
// MESSAGE: { "paymentId": "<payments.id UUID>", "seq": <positive integer> } and nothing else.
//   - paymentId is the only lookup key. Environment, status, amount and merchant order id are never
//     carried: the worker reads the authoritative payments row instead.
//   - seq is the fast-chain position (payments.metadata.fastReconcileSeq) this message is a link
//     for — a next link, or a payment-start recovery copy of the current one. It carries no
//     authority at all — it is only compared with the row, so a duplicate or superseded delivery
//     is recognised and acknowledged without a provider call (see fast-reconcile-payment.ts).

export interface FastReconcileMessage {
  paymentId: string;
  seq: number;
}

/** The single queue operation needed: enqueue a check `delaySeconds` from now. */
export interface ReconcileQueue {
  send(message: FastReconcileMessage, delaySeconds: number): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SEQ = 1_000_000;

export function serializeFastReconcileMessage(message: FastReconcileMessage): string {
  return JSON.stringify({ paymentId: message.paymentId, seq: message.seq });
}

/** Strict parse of an SQS body: a JSON object with a UUID paymentId and a positive integer seq.
 *  Bad JSON or a missing/mistyped field -> null. Any extra field (an "environment", an "amount") is
 *  ignored and never read. */
export function parseFastReconcileMessage(body: string | undefined | null): FastReconcileMessage | null {
  if (typeof body !== 'string' || body.length === 0 || body.length > 1024) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const { paymentId, seq } = parsed as { paymentId?: unknown; seq?: unknown };
  if (typeof paymentId !== 'string' || !UUID_RE.test(paymentId)) {
    return null;
  }
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1 || seq > MAX_SEQ) {
    return null;
  }
  return { paymentId: paymentId.toLowerCase(), seq };
}

/** A configured queue URL is a plain https URL; anything else is "not configured" (fail closed). */
export function isValidQueueUrl(value: string | undefined): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    return false;
  }
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Real SQS-backed queue. The SDK is required lazily (the Lambda runtime provides it; esbuild keeps
 *  @aws-sdk/* external), so merely importing this module loads nothing. */
export function createSqsReconcileQueue(queueUrl: string): ReconcileQueue {
  let client: import('@aws-sdk/client-sqs').SQSClient | undefined;
  return {
    async send(message, delaySeconds) {
      const sqs = require('@aws-sdk/client-sqs') as typeof import('@aws-sdk/client-sqs');
      client ??= new sqs.SQSClient({});
      await client.send(
        new sqs.SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: serializeFastReconcileMessage(message),
          DelaySeconds: Math.max(0, Math.min(900, Math.trunc(delaySeconds))),
        }),
      );
    },
  };
}
