/**
 * Per-environment PhonePe payment configuration for the Play X Cafe CDK app.
 *
 * Kept separate from the other per-concern config files (see api-config.ts). None of this is a
 * credential: the PhonePe client id/secret live only in the pre-existing Secrets Manager secret
 * named below, which CDK references by name and NEVER creates, reads or prints.
 */
export interface PaymentConfig {
  /** Name (not ARN) of the existing Secrets Manager secret holding the PhonePe credentials. */
  phonepeSecretName: string;
  /** Expected PhonePe environment; the backend cross-checks it against the secret's own value. */
  phonepeEnvironment: 'SANDBOX' | 'PRODUCTION';
  /** Minutes a simulator hold / PhonePe order lives once checkout starts (backend bounds: 5-60). */
  checkoutHoldMinutes: number;
  /** Customer return page PhonePe redirects to after checkout (UX only, never payment proof). */
  returnUrl: string;
  /** Server-side payment-start kill switch, rendered as the Lambda's PAYMENT_START_ENABLED
   *  ('true'/'false'). Always set explicitly — the backend treats anything but "true" as off. */
  paymentStartEnabled: boolean;
  /** Server-side booking-creation kill switch for this runtime's create-booking Lambda, rendered
   *  as BOOKING_CREATE_ENABLED ('true'/'false'). Always set explicitly — the backend treats
   *  anything but "true" as off. */
  bookingCreateEnabled: boolean;
}

export const paymentConfigs: Record<'dev' | 'prod', PaymentConfig> = {
  dev: {
    phonepeSecretName: 'playx/phonepe/sandbox',
    phonepeEnvironment: 'SANDBOX',
    checkoutHoldMinutes: 20,
    returnUrl: 'https://staging.playxcafe.com/payment-return.html',
    paymentStartEnabled: true,
    bookingCreateEnabled: true,
  },
  prod: {
    // TODO: revisit before a prod stack exists (a production PhonePe secret + production return
    // URL). Not read by any stack this phase (see bin/infra.ts).
    phonepeSecretName: 'playx/phonepe/sandbox',
    phonepeEnvironment: 'SANDBOX',
    checkoutHoldMinutes: 20,
    returnUrl: 'https://staging.playxcafe.com/payment-return.html',
    paymentStartEnabled: false,
    bookingCreateEnabled: false,
  },
};

/**
 * PhonePe cutover Stage 2A: the isolated PRODUCTION PhonePe payment runtime that lives INSIDE the
 * existing shared stack (same account, HttpApi, VPC, NAT, RDS, Cognito and simulator inventory) —
 * alongside the sandbox runtime above. This is NOT the config of a separate AWS "prod" stack
 * (that is paymentConfigs.prod, which no stack reads yet); the 'dev'/'prod' key is only the stack
 * this runtime is added to.
 *
 * The environment is fixed here, at deploy time: no request header/body/Origin/hostname can
 * choose it. The type pins `phonepeEnvironment` to PRODUCTION and, for Stage 2A, both
 * `paymentStartEnabled` and `bookingCreateEnabled` to the literal `false` — POST
 * /payments/production/start and POST /bookings/production both exist but are inert (503, no DB
 * work, no inventory hold) until a deliberate code change to this type, not just a config flip.
 */
export interface ProductionPaymentConfig
  extends Omit<PaymentConfig, 'phonepeEnvironment' | 'paymentStartEnabled' | 'bookingCreateEnabled'> {
  phonepeEnvironment: 'PRODUCTION';
  paymentStartEnabled: false;
  bookingCreateEnabled: false;
}

export const productionPaymentConfigs: Record<'dev' | 'prod', ProductionPaymentConfig> = {
  dev: {
    phonepeSecretName: 'playx/phonepe/production',
    phonepeEnvironment: 'PRODUCTION',
    checkoutHoldMinutes: 20,
    returnUrl: 'https://playxcafe.com/payment-return.html',
    paymentStartEnabled: false,
    bookingCreateEnabled: false,
  },
  prod: {
    // Not read by any stack this phase (see bin/infra.ts).
    phonepeSecretName: 'playx/phonepe/production',
    phonepeEnvironment: 'PRODUCTION',
    checkoutHoldMinutes: 20,
    returnUrl: 'https://playxcafe.com/payment-return.html',
    paymentStartEnabled: false,
    bookingCreateEnabled: false,
  },
};

/**
 * Who may start a SANDBOX payment: comma-separated Cognito subs and/or verified emails, supplied at
 * deploy time via `cdk deploy -c phonepeSandboxTesters=...` or the PHONEPE_SANDBOX_TESTERS
 * environment variable — never committed. Empty/absent is valid and FAILS CLOSED: the backend
 * (lib/sandbox-access.ts) then denies every payment start. The value is a plain Lambda environment
 * variable (visible to anyone who can read the function configuration); it holds no secret.
 */
export function resolveSandboxTesters(contextValue: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const raw = typeof contextValue === 'string' && contextValue.trim() !== '' ? contextValue : (env.PHONEPE_SANDBOX_TESTERS ?? '');
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(',');
}
