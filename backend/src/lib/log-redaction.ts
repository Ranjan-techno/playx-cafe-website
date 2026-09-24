// Stage 2E: log sanitization for the Lambdas that load the PhonePe SDK.
//
// During the production OIM007 incident the SDK itself (TokenService.getOAuthToken) did
// `console.warn('No cached token, error occurred while fetching new token', error)` with its raw
// PhonePeException — whose `data` carried PhonePe's response context, including the clientId.
// This code never logs raw provider objects, but third-party code in the same process can, so
// phonepe-runtime.ts (the only module that builds an SDK client) installs this guard on `console`
// before the SDK is ever used.
//
// The guard keeps primitive arguments (the log message strings, which in our code are already
// sanitized) and replaces every object/Error argument with a one-line summary holding only:
//   - the error class (PhonePeException.type / Error.name),
//   - the HTTP status,
//   - the provider error code (e.g. OIM007), when it is a short plain token.
// Never kept: `data`/response bodies, messages (the SDK copies PhonePe's response message into
// them), headers (Authorization), tokens, credentials, stacks, request/callback bodies.

const SAFE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,64}$/;

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN_RE.test(value) ? value : undefined;
}

/** A provider error code worth logging (e.g. "OIM007"), or undefined for anything that isn't a
 *  short plain token. */
export function safeProviderCode(value: unknown): string | undefined {
  return safeToken(value);
}

/** One-line, credential-free summary of any thrown value or logged object. */
export function describeForLog(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return `[redacted ${typeof value}]`;
  }
  const v = value as { type?: unknown; name?: unknown; httpStatusCode?: unknown; status?: unknown; code?: unknown };
  const isError = value instanceof Error;
  const errorClass = safeToken(v.type) ?? safeToken(v.name) ?? (isError ? 'Error' : undefined);
  if (!errorClass) {
    return '[redacted object]';
  }
  const parts = [`[redacted ${errorClass}`];
  const status = typeof v.httpStatusCode === 'number' ? v.httpStatusCode : typeof v.status === 'number' ? v.status : undefined;
  if (status !== undefined && Number.isInteger(status)) {
    parts.push(`httpStatus=${status}`);
  }
  const code = safeProviderCode(v.code);
  if (code) {
    parts.push(`code=${code}`);
  }
  return `${parts.join(' ')}]`;
}

/** Primitives pass through unchanged; every object (errors, response bodies, headers, ...) is
 *  replaced with describeForLog()'s summary. */
export function sanitizeLogArgument(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return value;
    default:
      return describeForLog(value);
  }
}

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error' | 'debug';
const METHODS: readonly ConsoleMethod[] = ['log', 'info', 'warn', 'error', 'debug'];
const INSTALLED = Symbol.for('playx.consoleRedactionInstalled');

type ConsoleLike = Pick<Console, ConsoleMethod> & { [INSTALLED]?: true };

/** Wraps `target`'s log methods so no object argument is ever written as-is. Idempotent. */
export function installConsoleRedaction(target: ConsoleLike = console): void {
  if (target[INSTALLED]) {
    return;
  }
  for (const method of METHODS) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(sanitizeLogArgument));
  }
  target[INSTALLED] = true;
}
