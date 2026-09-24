// Builds the real PhonePe provider from Secrets Manager config. The only module that turns
// credentials into an SDK client; handlers get back a provider (plus its non-secret
// `environment`) and never see the credentials themselves.

import { Env, StandardCheckoutClient } from '@phonepe-pg/pg-sdk-node';
import type { BoundCallbackValidator } from './phonepe-callback';
import { loadPhonePeConfig, type PhonePeEnvironment } from './phonepe-config';
import { PhonePePaymentProvider } from './phonepe-payment-provider';

let provider: PhonePePaymentProvider | null = null;

/** `returnUrl` is the customer redirect target (the future payment-return page); optional because
 *  start-payment can pass one per request. */
export async function getPhonePePaymentProvider(returnUrl?: string): Promise<PhonePePaymentProvider> {
  const config = await loadPhonePeConfig();
  if (provider && provider.environment === config.environment) {
    return provider;
  }
  // shouldPublishEvents=false: no SDK telemetry to PhonePe (the SDK only sends it in PRODUCTION
  // anyway). StandardCheckoutClient is a process-wide singleton inside the SDK.
  const client = StandardCheckoutClient.getInstance(
    config.clientId,
    config.clientSecret,
    config.clientVersion,
    Env[config.environment],
    false,
  );
  provider = new PhonePePaymentProvider(client, { environment: config.environment, returnUrl });
  return provider;
}

/** The PhonePe secret has no webhookUsername/webhookPassword pair: callbacks cannot be
 *  authenticated, so none may be accepted. Carries no value, only the fact. */
export class WebhookCredentialsUnavailableError extends Error {
  readonly name = 'WebhookCredentialsUnavailableError';
  constructor() {
    super('PhonePe webhook credentials are unavailable');
  }
}

export interface PhonePeWebhookRuntime {
  /** The environment the secret itself declares (never a request value). */
  environment: PhonePeEnvironment;
  /** For the authoritative order-status call once a callback has been authenticated. */
  provider: PhonePePaymentProvider;
  /** The SDK's StandardCheckoutClient.validateCallback with the webhook username/password bound
   *  here, so the handler never holds them. Throws exactly what the SDK throws. */
  validateCallback: BoundCallbackValidator;
}

/** PhonePe cutover Stage 2C: everything the PRODUCTION webhook Lambda needs, from the same secret
 *  (PHONEPE_SECRET_NAME) as its provider. Throws WebhookCredentialsUnavailableError when the secret
 *  has no webhook credentials (parsePhonePeSecret already rejects a half-set or blank pair), and
 *  PhonePeConfigError for any other secret problem — the caller fails closed on both. */
export async function getPhonePeWebhookRuntime(): Promise<PhonePeWebhookRuntime> {
  const config = await loadPhonePeConfig();
  const { webhookUsername, webhookPassword } = config;
  if (!webhookUsername || !webhookPassword) {
    throw new WebhookCredentialsUnavailableError();
  }
  const paymentProvider = await getPhonePePaymentProvider();
  // Same arguments as getPhonePePaymentProvider(), so the SDK singleton hands back the same client.
  const client = StandardCheckoutClient.getInstance(
    config.clientId,
    config.clientSecret,
    config.clientVersion,
    Env[config.environment],
    false,
  );
  return {
    environment: config.environment,
    provider: paymentProvider,
    validateCallback: (authorization, rawBody) =>
      client.validateCallback(webhookUsername, webhookPassword, authorization, rawBody),
  };
}
