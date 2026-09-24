// PhonePe credential loader. Credentials live only in AWS Secrets Manager (default secret name
// `playx/phonepe/sandbox`, supplied to the Lambda via PHONEPE_SECRET_NAME) and are read here and
// nowhere else. Handlers never receive them: phonepe-runtime.ts turns this config into a
// provider object, and only the non-secret `environment` is ever exposed alongside it.
//
// Fails closed: any missing/malformed field (including a clientId containing whitespace, or a
// padded clientVersion/environment/webhookUsername), or a secret/environment mismatch, throws a
// PhonePeConfigError whose message names only the offending *field* — never a value, and never
// any fragment of the raw secret text (JSON.parse's own error message quotes the input, so it is
// deliberately swallowed).
//
// Webhook username/password are OPTIONAL in the model (set together or not at all): payment-start/
// order-status/reconciliation must not require them. Only the PRODUCTION webhook Lambda (Stage 2C,
// phonepe-runtime.ts's getPhonePeWebhookRuntime) needs them, and it fails closed without them.

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type PhonePeEnvironment = 'SANDBOX' | 'PRODUCTION';

export const SANDBOX_SECRET_NAME = 'playx/phonepe/sandbox';

export interface PhonePeConfig {
  clientId: string;
  clientSecret: string;
  clientVersion: number;
  environment: PhonePeEnvironment;
  webhookUsername?: string;
  webhookPassword?: string;
}

export class PhonePeConfigError extends Error {
  readonly code = 'phonepe_config_invalid';
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** An identifier that PhonePe matches exactly (clientId): non-empty with NO whitespace anywhere.
 *  Stage 2E hardening: a production clientId with one trailing space passed the old non-empty
 *  check, reached PhonePe and failed there as OIM007 "Client Not Found". Never trimmed — a padded
 *  value is a Secrets Manager mistake to fix at the source, not to guess around. */
function isWhitespaceFreeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value);
}

/** Non-empty, not all whitespace, and no leading/trailing whitespace (inner spaces allowed). */
function isUnpaddedString(value: unknown): value is string {
  return nonEmptyString(value) && value === value.trim();
}

/** Validates the parsed secret JSON. Accepts clientVersion as a positive integer, or a string of
 *  digits (the Secrets Manager console's key/value editor stores every value as a string). */
export function parsePhonePeSecret(secretString: string | undefined): PhonePeConfig {
  if (!secretString) {
    throw new PhonePeConfigError('PhonePe secret is empty');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    // Deliberately not chaining/including the parse error: it can quote the secret text.
    throw new PhonePeConfigError('PhonePe secret is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PhonePeConfigError('PhonePe secret must be a JSON object');
  }
  const secret = parsed as Record<string, unknown>;

  if (!nonEmptyString(secret.clientId)) {
    throw new PhonePeConfigError('PhonePe secret field "clientId" must be a non-empty string');
  }
  if (!isWhitespaceFreeIdentifier(secret.clientId)) {
    throw new PhonePeConfigError('PhonePe secret field "clientId" must not contain whitespace');
  }
  // clientSecret is passed to PhonePe byte-for-byte: never trimmed or otherwise altered here, and
  // only required to be non-empty (its exact character set is PhonePe's to define).
  if (!nonEmptyString(secret.clientSecret)) {
    throw new PhonePeConfigError('PhonePe secret field "clientSecret" must be a non-empty string');
  }

  // A number, or a string of digits exactly as stored (the Secrets Manager console's key/value
  // editor stores every value as a string). "1 " / " 1" are refused, not trimmed.
  const rawVersion = secret.clientVersion;
  const clientVersion =
    typeof rawVersion === 'number'
      ? rawVersion
      : typeof rawVersion === 'string' && /^\d{1,9}$/.test(rawVersion)
        ? Number.parseInt(rawVersion, 10)
        : Number.NaN;
  if (!Number.isSafeInteger(clientVersion) || clientVersion <= 0) {
    throw new PhonePeConfigError('PhonePe secret field "clientVersion" must be a positive integer');
  }

  // Exact match only: " PRODUCTION", "PRODUCTION\n" or "production" are refused.
  if (secret.environment !== 'SANDBOX' && secret.environment !== 'PRODUCTION') {
    throw new PhonePeConfigError('PhonePe secret field "environment" must be SANDBOX or PRODUCTION');
  }

  const hasUser = secret.webhookUsername !== undefined;
  const hasPassword = secret.webhookPassword !== undefined;
  if (hasUser !== hasPassword) {
    throw new PhonePeConfigError('PhonePe secret must set webhookUsername and webhookPassword together');
  }
  if (hasUser && (!nonEmptyString(secret.webhookUsername) || !nonEmptyString(secret.webhookPassword))) {
    throw new PhonePeConfigError('PhonePe secret webhook credentials must be non-empty strings');
  }
  // The username is an identifier: padding is refused. The password, like clientSecret, is used
  // exactly as stored (never trimmed) and only has to be non-empty.
  if (hasUser && !isUnpaddedString(secret.webhookUsername)) {
    throw new PhonePeConfigError('PhonePe secret field "webhookUsername" must not have leading or trailing whitespace');
  }

  return {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    clientVersion,
    environment: secret.environment,
    ...(hasUser ? { webhookUsername: secret.webhookUsername as string, webhookPassword: secret.webhookPassword as string } : {}),
  };
}

/** Startup assertion: the SANDBOX secret must be the sandbox secret and only it; a PRODUCTION
 *  config must never be sourced from anything sandbox-named. `secretId` may be a plain name or a
 *  full ARN (which embeds the name), so this matches on containment. `expectedEnvironment`
 *  (PHONEPE_ENVIRONMENT) is an optional second, independent statement of intent from the deploy
 *  config. */
export function assertSecretMatchesEnvironment(
  secretId: string,
  environment: PhonePeEnvironment,
  expectedEnvironment?: string,
): void {
  const looksSandbox = secretId.toLowerCase().includes(SANDBOX_SECRET_NAME);
  if (environment === 'SANDBOX' && !looksSandbox) {
    throw new PhonePeConfigError(`SANDBOX PhonePe config must be loaded from the ${SANDBOX_SECRET_NAME} secret`);
  }
  if (environment === 'PRODUCTION' && secretId.toLowerCase().includes('sandbox')) {
    throw new PhonePeConfigError('PRODUCTION PhonePe config must not be loaded from a sandbox secret');
  }
  if (expectedEnvironment !== undefined && expectedEnvironment !== '' && expectedEnvironment !== environment) {
    throw new PhonePeConfigError(
      `PHONEPE_ENVIRONMENT is ${expectedEnvironment} but the secret's environment is ${environment}`,
    );
  }
}

/** The one call this module needs from Secrets Manager — an interface so tests inject a fake
 *  instead of mocking the AWS SDK. */
export interface SecretStringSource {
  getSecretString(secretId: string): Promise<string | undefined>;
}

class AwsSecretStringSource implements SecretStringSource {
  async getSecretString(secretId: string): Promise<string | undefined> {
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return response.SecretString;
  }
}

const CACHE_TTL_MS = 10 * 60_000;

let cached: { secretId: string; config: PhonePeConfig; expiresAt: number } | null = null;
let inflight: { secretId: string; promise: Promise<PhonePeConfig> } | null = null;

export function resetPhonePeConfigCache(): void {
  cached = null;
  inflight = null;
}

export interface LoadPhonePeConfigOptions {
  secretId?: string;
  expectedEnvironment?: string;
  source?: SecretStringSource;
  now?: () => number;
}

/** Loads (and caches per Lambda execution environment, for 10 minutes so a rotated secret is
 *  eventually picked up) the validated config. Failures are never cached. Concurrent first calls
 *  share one Secrets Manager request. */
export async function loadPhonePeConfig(options: LoadPhonePeConfigOptions = {}): Promise<PhonePeConfig> {
  const secretId = options.secretId ?? process.env.PHONEPE_SECRET_NAME;
  if (!secretId) {
    throw new PhonePeConfigError('PHONEPE_SECRET_NAME environment variable is not set');
  }
  const now = (options.now ?? Date.now)();
  if (cached && cached.secretId === secretId && cached.expiresAt > now) {
    return cached.config;
  }
  if (inflight && inflight.secretId === secretId) {
    return inflight.promise;
  }

  const source = options.source ?? new AwsSecretStringSource();
  const expectedEnvironment = options.expectedEnvironment ?? process.env.PHONEPE_ENVIRONMENT;
  const promise = (async () => {
    let secretString: string | undefined;
    try {
      secretString = await source.getSecretString(secretId);
    } catch {
      throw new PhonePeConfigError('Failed to read the PhonePe secret from Secrets Manager');
    }
    const config = parsePhonePeSecret(secretString);
    assertSecretMatchesEnvironment(secretId, config.environment, expectedEnvironment);
    cached = { secretId, config, expiresAt: now + CACHE_TTL_MS };
    return config;
  })().finally(() => {
    inflight = null;
  });
  inflight = { secretId, promise };
  return promise;
}
