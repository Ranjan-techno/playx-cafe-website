import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { ApiConfig } from '../config/api-config';
import { PaymentConfig, ProductionPaymentConfig } from '../config/payment-config';

export interface ApiConstructProps {
  apiConfig: ApiConfig;
  /** Full resource name for the HTTP API, e.g. 'playx-dev-api'. */
  httpApiName: string;
  /** Full resource name for the health-check Lambda, e.g. 'playx-dev-health'. */
  healthFunctionName: string;
  /** Full resource name for the products-list Lambda, e.g. 'playx-dev-products'. */
  productsFunctionName: string;
  /** Full resource name for the create-booking Lambda, e.g. 'playx-dev-create-booking'. */
  createBookingFunctionName: string;
  /** PhonePe cutover Stage 2A: POST /bookings/production's Lambda, e.g.
   *  'playx-dev-create-booking-production'. */
  createBookingProductionFunctionName: string;
  /** Full resource name for the list-my-bookings Lambda, e.g. 'playx-dev-bookings-me'. */
  listMyBookingsFunctionName: string;
  /** Full resource name for the Phase 2 availability Lambda, e.g. 'playx-dev-availability'. */
  availabilityFunctionName: string;
  /** Full resource name for the passwordless auth-start Lambda, e.g. 'playx-dev-auth-start'. */
  authStartFunctionName: string;
  /** Full resource name for the passwordless auth-verify Lambda, e.g. 'playx-dev-auth-verify'. */
  authVerifyFunctionName: string;

  /** Phase 3B: full resource names for the PLAY X ADMIN Lambdas, e.g. 'playx-dev-admin-dashboard'. */
  adminDashboardFunctionName: string;
  adminBookingsFunctionName: string;
  adminBookingDetailFunctionName: string;
  adminPaymentsFunctionName: string;
  adminSimulatorsFunctionName: string;
  adminBookingStatusFunctionName: string;

  /** PhonePe payments (Phase 2): full resource names for the two customer payment Lambdas. */
  paymentStartFunctionName: string;
  paymentStatusFunctionName: string;
  /** Phase 5A: scheduled background reconciliation Lambda, e.g. 'playx-dev-payment-reconcile'. */
  paymentReconcileFunctionName: string;
  paymentConfig: PaymentConfig;
  /** PhonePe cutover Stage 2A: POST /payments/production/start's Lambda, e.g.
   *  'playx-dev-payment-start-production'. */
  paymentStartProductionFunctionName: string;
  /** The isolated PRODUCTION PhonePe runtime's config (payment start hard-disabled in Stage 2A). */
  productionPaymentConfig: ProductionPaymentConfig;
  /** PhonePe cutover Stage 2B: PRODUCTION fast payment reconciliation — the SQS worker Lambda
   *  (e.g. 'playx-dev-payment-reconcile-production-fast'), its queue and DLQ names, the DLQ alarm
   *  name, and the 5-minute PRODUCTION fallback reconciler (e.g.
   *  'playx-dev-payment-reconcile-production'). */
  paymentReconcileProductionFastFunctionName: string;
  paymentReconcileProductionFastQueueName: string;
  paymentReconcileProductionDlqName: string;
  paymentReconcileProductionDlqAlarmName: string;
  paymentReconcileProductionFunctionName: string;
  /** PhonePe cutover Stage 2C: GET /payments/production/{bookingId}/status's Lambda (e.g.
   *  'playx-dev-payment-status-production') and the public PhonePe callback Lambda behind
   *  POST /payments/production/webhook (e.g. 'playx-dev-payment-webhook-production'). */
  paymentStatusProductionFunctionName: string;
  paymentWebhookProductionFunctionName: string;
  /** Comma-separated Cognito subs/verified emails allowed to start SANDBOX payments. Empty fails
   *  closed (nobody may start one) — see config/payment-config.ts. */
  phonepeSandboxTesters: string;
  /** Stage 2C: comma-separated Cognito subs (only) allowed to create PRODUCTION bookings and start
   *  PRODUCTION payments once the production kill switches are on. Empty fails closed — see
   *  config/payment-config.ts's resolveProductionTesters. */
  phonepeProductionTesters: string;

  /** Story 2.1 VPC — the products/booking Lambdas need this to reach the Story 2.2 database. */
  vpc: ec2.IVpc;
  /** The Story 2.2 Lambda security group, reused here (same pattern as constructs/migration.ts)
   *  rather than creating a new one. */
  lambdaSecurityGroup: ec2.SecurityGroup;
  /** The RDS instance's generated-credentials secret. */
  databaseSecret: secretsmanager.ISecret;

  /** Story 2.4 Cognito User Pool — source of truth for the JWT authorizer on /bookings*. */
  userPool: cognito.UserPool;
  /** Story 2.4 public web app client — the only client this API accepts tokens from. */
  webClient: cognito.UserPoolClient;
}

/**
 * Story 2.5 introduced this HTTP API with a single public GET /health route. Story 2.6 adds:
 *   - GET /products (public) — the product catalog behind the booking flow.
 *   - POST /bookings and GET /bookings/me (Cognito JWT-protected) — creating and listing
 *     bookings for the authenticated user, identified only by the verified "sub" claim API
 *     Gateway attaches after validating the token; never a user id from the request itself.
 *
 * The three new Lambdas are, unlike healthFunction, VPC-attached (PRIVATE_ISOLATED subnets, on
 * the Story 2.2 lambdaSecurityGroup) so they can reach the database — mirroring the Story 2.3
 * migration function's networking, and reusing the same Secrets Manager VPC interface endpoint
 * MigrationConstruct already provisions (they're on the same security group, so they already
 * satisfy its self-referencing 443 ingress rule; no new endpoint is created here).
 *
 * Guest-first passwordless auth adds POST /auth/start and POST /auth/verify (both public — the
 * caller has no token yet, that's the whole point). Like healthFunction, neither is VPC-attached:
 * they only call Cognito's regional Admin* APIs, never the database. See backend/src/handlers/
 * auth-start.ts and auth-verify.ts for the CUSTOM_AUTH flow itself (a Cognito CUSTOM_AUTH
 * challenge driving Play X's own six-digit OTP — see constructs/auth.ts's `lambdaTriggers` and
 * backend/src/lib/otp.ts for why this isn't Cognito's native EMAIL_OTP first factor).
 *
 * Phase 2 (automated simulator availability and allocation) adds GET /availability (public, like
 * GET /products — a visitor can browse real inventory-backed availability before signing in).
 * It's VPC-attached like products/create-booking/bookings-me, reading the new simulators/
 * booking_allocations tables (database/migrations/002_simulator_inventory.sql) — see
 * backend/src/handlers/availability.ts.
 *
 * Phase 3B (PLAY X ADMIN backend) adds six /admin/* routes — GET /admin/dashboard, GET
 * /admin/bookings, GET /admin/bookings/{id}, PATCH /admin/bookings/{id}/status, GET
 * /admin/payments, GET /admin/simulators — all behind the same Cognito JWT authorizer as
 * /bookings and GET /bookings/me, plus each handler's own backend requireAdmin() check (Cognito
 * "admin" group membership — see constructs/auth.ts's adminGroup and
 * backend/src/lib/admin-auth.ts). No new User Pool, no new authorizer, no new app client.
 *
 * PhonePe cutover Stage 2A adds an isolated PRODUCTION booking + payment-start runtime on this same
 * HttpApi/VPC/RDS/Cognito/inventory: POST /bookings/production (create-booking-production.ts,
 * booking_environment='PRODUCTION', BOOKING_CREATE_ENABLED=false so it returns 503 before any DB
 * work) and POST /payments/production/start (the same payment-start.ts
 * handler, configured with the production PhonePe secret and PAYMENT_START_ENABLED=false, so it
 * returns 503 before touching the secret, the DB or PhonePe).
 *
 * PhonePe cutover Stage 2B adds PRODUCTION payment reconciliation, deployable idle before go-live:
 * an SQS fast-reconcile queue (+ DLQ and a DLQ-depth alarm) driving PhonePe's mandatory PENDING
 * status-check cadence through a worker Lambda, plus a 5-minute PRODUCTION fallback reconciler on
 * its own EventBridge rule. The production payment-start Lambda gets the queue URL and
 * sqs:SendMessage on that one queue (still disabled, so it never sends). No production
 * payment-status route and no webhook yet.
 *
 * PhonePe cutover Stage 2C adds, still with both production kill switches OFF:
 *   - POST /payments/production/webhook — PUBLIC (no JWT authorizer; PhonePe calls it server to
 *     server). Its Lambda authenticates each callback with the PhonePe SDK's validateCallback()
 *     using webhook credentials read from the production PhonePe secret at runtime (never in the
 *     Lambda environment), then triggers the authoritative PRODUCTION order-status check through
 *     the shared reconciliation path. Production secret only; no SQS.
 *   - GET /payments/production/{bookingId}/status — JWT-protected, the shared payment-status
 *     implementation hard-coded to PRODUCTION rows and the production secret.
 *   - PHONEPE_PRODUCTION_TESTERS (Cognito subs, from the `phonepeProductionTesters` context) on the
 *     production create-booking and payment-start Lambdas only — a second server-side gate behind
 *     their kill switches.
 *
 * PhonePe cutover Stage 2D (one controlled production transaction for PhonePe's verification)
 * turns ON exactly two switches — BOOKING_CREATE_ENABLED on the production create-booking Lambda
 * and PAYMENT_START_ENABLED on the production payment-start Lambda (productionPaymentConfigs.dev).
 * The tester allowlist above stays mandatory: an empty list or a non-listed sub is still 403
 * before any DB/provider work. Sandbox functions, the webhook and the status route are unchanged.
 */
export class ApiConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly healthFunction: lambdaNodejs.NodejsFunction;
  public readonly productsFunction: lambdaNodejs.NodejsFunction;
  public readonly createBookingFunction: lambdaNodejs.NodejsFunction;
  public readonly createBookingProductionFunction: lambdaNodejs.NodejsFunction;
  public readonly listMyBookingsFunction: lambdaNodejs.NodejsFunction;
  public readonly availabilityFunction: lambdaNodejs.NodejsFunction;
  public readonly authStartFunction: lambdaNodejs.NodejsFunction;
  public readonly authVerifyFunction: lambdaNodejs.NodejsFunction;
  public readonly adminDashboardFunction: lambdaNodejs.NodejsFunction;
  public readonly adminBookingsFunction: lambdaNodejs.NodejsFunction;
  public readonly adminBookingDetailFunction: lambdaNodejs.NodejsFunction;
  public readonly adminPaymentsFunction: lambdaNodejs.NodejsFunction;
  public readonly adminSimulatorsFunction: lambdaNodejs.NodejsFunction;
  public readonly adminBookingStatusFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentStartFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentStartProductionFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentStatusFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentReconcileFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentReconcileRule: events.Rule;
  public readonly paymentReconcileProductionFastQueue: sqs.Queue;
  public readonly paymentReconcileProductionDlq: sqs.Queue;
  public readonly paymentReconcileProductionDlqAlarm: cloudwatch.Alarm;
  public readonly paymentReconcileProductionFastFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentReconcileProductionFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentReconcileProductionRule: events.Rule;
  public readonly paymentStatusProductionFunction: lambdaNodejs.NodejsFunction;
  public readonly paymentWebhookProductionFunction: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: ApiConstructProps) {
    super(scope, id);

    this.healthFunction = new lambdaNodejs.NodejsFunction(this, 'HealthFunction', {
      functionName: props.healthFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/health.ts'),
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      // Pinned explicitly, matching this project's engineVersion/vpcCidr pinning convention
      // (see database-config.ts) rather than left to cdk.json's useLatestRuntimeVersion flag.
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      bundling: {
        // The Node.js 22 runtime ships its own AWS SDK v3; the health handler doesn't use it,
        // but excluding it keeps this consistent with the migration function's bundling config.
        externalModules: ['@aws-sdk/*'],
      },
    });

    const dbFunctionDefaults = {
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: props.databaseSecret.secretArn,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    };

    this.productsFunction = new lambdaNodejs.NodejsFunction(this, 'ProductsFunction', {
      ...dbFunctionDefaults,
      functionName: props.productsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/products.ts'),
    });
    props.databaseSecret.grantRead(this.productsFunction);

    this.createBookingFunction = new lambdaNodejs.NodejsFunction(this, 'CreateBookingFunction', {
      ...dbFunctionDefaults,
      functionName: props.createBookingFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/create-booking.ts'),
      environment: {
        ...dbFunctionDefaults.environment,
        // Explicit, never defaulted: the backend creates bookings only on the exact "true".
        BOOKING_CREATE_ENABLED: props.paymentConfig.bookingCreateEnabled ? 'true' : 'false',
      },
    });
    props.databaseSecret.grantRead(this.createBookingFunction);

    // PhonePe cutover Stage 2A: same business logic as CreateBookingFunction (create-booking.ts's
    // createBookingHandler), with booking_environment fixed to PRODUCTION by its entry file. Same
    // isolated subnets and DB access; no PhonePe secret or configuration at all.
    // BOOKING_CREATE_ENABLED was 'false' in Stages 2A-2C (503 before any DB connection). Stage 2D
    // turns it on for the controlled production transaction; PHONEPE_PRODUCTION_TESTERS (subs only;
    // empty = nobody) remains the second gate, so only an allowlisted tester can create a
    // PRODUCTION booking or hold shared simulator inventory — everyone else gets 403 before the DB.
    this.createBookingProductionFunction = new lambdaNodejs.NodejsFunction(this, 'CreateBookingProductionFunction', {
      ...dbFunctionDefaults,
      functionName: props.createBookingProductionFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/create-booking-production.ts'),
      environment: {
        ...dbFunctionDefaults.environment,
        BOOKING_CREATE_ENABLED: props.productionPaymentConfig.bookingCreateEnabled ? 'true' : 'false',
        PHONEPE_PRODUCTION_TESTERS: props.phonepeProductionTesters,
      },
    });
    props.databaseSecret.grantRead(this.createBookingProductionFunction);

    this.listMyBookingsFunction = new lambdaNodejs.NodejsFunction(this, 'ListMyBookingsFunction', {
      ...dbFunctionDefaults,
      functionName: props.listMyBookingsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/list-my-bookings.ts'),
    });
    props.databaseSecret.grantRead(this.listMyBookingsFunction);

    this.availabilityFunction = new lambdaNodejs.NodejsFunction(this, 'AvailabilityFunction', {
      ...dbFunctionDefaults,
      functionName: props.availabilityFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/availability.ts'),
    });
    props.databaseSecret.grantRead(this.availabilityFunction);

    // Phase 3B: PLAY X ADMIN — six Lambdas behind /admin/*, all Cognito-JWT-protected (via
    // cognitoAuthorizer below, the same authorizer /bookings*/ /bookings/me already use) plus a
    // backend requireAdmin() check inside each handler (see backend/src/lib/admin-auth.ts) — the
    // JWT authorizer alone only proves *some* signed-in Cognito user is calling, never that they're
    // an admin. VPC-attached like products/create-booking/bookings-me/availability, since every one
    // of these reads (and, for admin-booking-status, writes) the database directly.
    this.adminDashboardFunction = new lambdaNodejs.NodejsFunction(this, 'AdminDashboardFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminDashboardFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-dashboard.ts'),
    });
    props.databaseSecret.grantRead(this.adminDashboardFunction);

    this.adminBookingsFunction = new lambdaNodejs.NodejsFunction(this, 'AdminBookingsFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminBookingsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-bookings.ts'),
    });
    props.databaseSecret.grantRead(this.adminBookingsFunction);

    this.adminBookingDetailFunction = new lambdaNodejs.NodejsFunction(this, 'AdminBookingDetailFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminBookingDetailFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-booking-detail.ts'),
    });
    props.databaseSecret.grantRead(this.adminBookingDetailFunction);

    this.adminPaymentsFunction = new lambdaNodejs.NodejsFunction(this, 'AdminPaymentsFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminPaymentsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-payments.ts'),
    });
    props.databaseSecret.grantRead(this.adminPaymentsFunction);

    this.adminSimulatorsFunction = new lambdaNodejs.NodejsFunction(this, 'AdminSimulatorsFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminSimulatorsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-simulators.ts'),
    });
    props.databaseSecret.grantRead(this.adminSimulatorsFunction);

    // The only admin route that writes (PATCH .../status) — still just databaseSecret.grantRead()
    // (read access to the DB *credentials* secret), same as every other Lambda here; the actual
    // UPDATE permission is a Postgres-level grant on the credentials' own DB role, not an IAM
    // action, so no additional IAM policy is needed for this one to write.
    this.adminBookingStatusFunction = new lambdaNodejs.NodejsFunction(this, 'AdminBookingStatusFunction', {
      ...dbFunctionDefaults,
      functionName: props.adminBookingStatusFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/admin-booking-status.ts'),
    });
    props.databaseSecret.grantRead(this.adminBookingStatusFunction);

    // PhonePe payments (Phase 2): the ONLY Lambdas placed in the PRIVATE_WITH_EGRESS subnets (NAT
    // route out to PhonePe over HTTPS). They still use the shared Story 2.2 Lambda security group,
    // so the DB security group's 5432-from-lambda-sg rule keeps working, and reach RDS over the
    // VPC-local route. Every other Lambda stays exactly where it was.
    //
    // PhonePe credentials: EXISTING Secrets Manager secrets, referenced by name only (CDK never
    // creates or reads them). Each payment role gets secretsmanager:GetSecretValue on exactly ONE
    // secret — the sandbox Lambdas on the sandbox secret, the production Lambda on the production
    // secret — no wildcard, no DescribeSecret. The "-??????" is the random 6-character suffix
    // Secrets Manager appends to every secret ARN (so 'playx/phonepe/sandbox-??????' can never
    // match the production secret, nor vice versa).
    const phonepeSecretArnFor = (secretName: string): string =>
      cdk.Stack.of(this).formatArn({
        service: 'secretsmanager',
        resource: 'secret',
        resourceName: `${secretName}-??????`,
        arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
      });
    const grantPhonePeSecret = (fn: lambdaNodejs.NodejsFunction, secretName: string = props.paymentConfig.phonepeSecretName): void => {
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [phonepeSecretArnFor(secretName)] }),
      );
    };
    const paymentFunctionDefaults = {
      ...dbFunctionDefaults,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      // Provider HTTP calls happen here; API Gateway HTTP APIs cut off at 30s regardless.
      timeout: cdk.Duration.seconds(25),
      memorySize: 512,
    };
    const phonepeCommonEnv = {
      DB_SECRET_ARN: props.databaseSecret.secretArn,
      PHONEPE_SECRET_NAME: props.paymentConfig.phonepeSecretName,
      PHONEPE_ENVIRONMENT: props.paymentConfig.phonepeEnvironment,
    };

    this.paymentStartFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentStartFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentStartFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-start.ts'),
      environment: {
        ...phonepeCommonEnv,
        PHONEPE_SANDBOX_TESTERS: props.phonepeSandboxTesters,
        PAYMENT_CHECKOUT_HOLD_MINUTES: String(props.paymentConfig.checkoutHoldMinutes),
        PAYMENT_RETURN_URL: props.paymentConfig.returnUrl,
        // Explicit, never defaulted: the backend enables payment start only on the exact "true".
        PAYMENT_START_ENABLED: props.paymentConfig.paymentStartEnabled ? 'true' : 'false',
      },
    });
    props.databaseSecret.grantRead(this.paymentStartFunction);
    grantPhonePeSecret(this.paymentStartFunction);

    // PhonePe cutover Stage 2B: the PRODUCTION fast-reconcile queue. Standard (not FIFO): the
    // worker tolerates duplicate delivery (a stale/duplicate link is acknowledged without a provider
    // call — see backend/src/lib/fast-reconcile-payment.ts), and messages carry only
    // { paymentId, seq }. Created before the payment-start Lambda, which needs its URL.
    //   - visibility timeout 150s = 6x the worker's 25s timeout (AWS's guidance for SQS-triggered
    //     Lambdas), so an in-flight message is never redelivered mid-invocation;
    //   - retention 1 day: a link is only useful until the order expires (minutes); anything older is
    //     covered by the 5-minute fallback reconciler;
    //   - after 5 failed receives a message moves to the DLQ (14 days' retention, alarmed below).
    this.paymentReconcileProductionDlq = new sqs.Queue(this, 'PaymentReconcileProductionDlq', {
      queueName: props.paymentReconcileProductionDlqName,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    this.paymentReconcileProductionFastQueue = new sqs.Queue(this, 'PaymentReconcileProductionFastQueue', {
      queueName: props.paymentReconcileProductionFastQueueName,
      visibilityTimeout: cdk.Duration.seconds(150),
      retentionPeriod: cdk.Duration.days(1),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: this.paymentReconcileProductionDlq, maxReceiveCount: 5 },
    });
    const productionQueue = this.paymentReconcileProductionFastQueue;
    // SendMessage ONLY, on exactly this queue — no GetQueueAttributes/GetQueueUrl (the URL comes from
    // the environment), no wildcard. Used by the production payment-start Lambda and the worker's
    // delayed requeue. The sandbox payment Lambdas never get it.
    const grantProductionQueueSend = (fn: lambdaNodejs.NodejsFunction): void => {
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: [productionQueue.queueArn] }));
    };

    // PhonePe cutover Stage 2A: the isolated PRODUCTION payment-start runtime. Same handler code,
    // subnets, security group and DB access as PaymentStartFunction; its PhonePe environment,
    // secret and return URL are fixed here at deploy time (productionPaymentConfig), and its IAM
    // reaches ONLY the production secret. PAYMENT_START_ENABLED was 'false' in Stages 2A-2C (503
    // before the DB, the secret or PhonePe); Stage 2D turns it on for the controlled production
    // transaction. No sandbox tester list: the SANDBOX gate never applies here. Stage 2C's
    // PHONEPE_PRODUCTION_TESTERS (subs only; empty = nobody) still answers 403 to every
    // non-allowlisted caller before the DB, the secret, PhonePe or SQS.
    const productionPayment = props.productionPaymentConfig;
    this.paymentStartProductionFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentStartProductionFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentStartProductionFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-start.ts'),
      environment: {
        DB_SECRET_ARN: props.databaseSecret.secretArn,
        PHONEPE_SECRET_NAME: productionPayment.phonepeSecretName,
        PHONEPE_ENVIRONMENT: productionPayment.phonepeEnvironment,
        PAYMENT_CHECKOUT_HOLD_MINUTES: String(productionPayment.checkoutHoldMinutes),
        PAYMENT_RETURN_URL: productionPayment.returnUrl,
        PAYMENT_START_ENABLED: productionPayment.paymentStartEnabled ? 'true' : 'false',
        // Stage 2B: every PRODUCTION order must start the fast-reconcile chain; the handler fails
        // closed (before PhonePe) without this.
        PAYMENT_RECONCILE_QUEUE_URL: productionQueue.queueUrl,
        PHONEPE_PRODUCTION_TESTERS: props.phonepeProductionTesters,
      },
    });
    props.databaseSecret.grantRead(this.paymentStartProductionFunction);
    grantPhonePeSecret(this.paymentStartProductionFunction, productionPayment.phonepeSecretName);
    grantProductionQueueSend(this.paymentStartProductionFunction);

    this.paymentStatusFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentStatusFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentStatusFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-status.ts'),
      environment: phonepeCommonEnv,
    });
    props.databaseSecret.grantRead(this.paymentStatusFunction);
    grantPhonePeSecret(this.paymentStatusFunction);

    // Phase 5A: background reconciliation, so a customer never depends on returning to
    // payment-return.html. Same placement as the other payment Lambdas (private-with-egress subnets
    // behind the existing single NAT, shared Lambda SG): RDS over the VPC-local route, PhonePe over
    // NAT. IAM is exactly what the handler needs — read the DB secret and GetSecretValue on the one
    // PhonePe secret. No API route, no other permissions, no new NAT/VPC resources.
    this.paymentReconcileFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentReconcileFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentReconcileFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-reconcile.ts'),
      // Not bound by API Gateway's 30s cut-off: a bounded batch (25) of sequential provider calls.
      // The handler stops starting new items when <30s remain.
      timeout: cdk.Duration.minutes(4),
      environment: {
        ...phonepeCommonEnv,
        RECONCILE_BATCH_SIZE: '25',
      },
    });
    props.databaseSecret.grantRead(this.paymentReconcileFunction);
    grantPhonePeSecret(this.paymentReconcileFunction);

    this.paymentReconcileRule = new events.Rule(this, 'PaymentReconcileSchedule', {
      description: 'Every 5 minutes: reconcile open PhonePe payment attempts (background sweep)',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new eventsTargets.LambdaFunction(this.paymentReconcileFunction, {
          // The next scheduled run is the retry; async retries would only overlap it.
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(5),
        }),
      ],
    });

    // PhonePe cutover Stage 2B: PRODUCTION reconciliation. Both Lambdas run exactly like the sandbox
    // reconciler (private-with-egress subnets, shared Lambda SG, RDS over the VPC, PhonePe over the
    // existing NAT) but read ONLY the production PhonePe secret. Their PRODUCTION environment is
    // hard-coded in their entry files; PHONEPE_ENVIRONMENT here is only the loader's independent
    // cross-check against the secret.
    const productionPhonepeEnv = {
      DB_SECRET_ARN: props.databaseSecret.secretArn,
      PHONEPE_SECRET_NAME: productionPayment.phonepeSecretName,
      PHONEPE_ENVIRONMENT: productionPayment.phonepeEnvironment,
    };

    // The fast worker: one message = one PhonePe status check for one attempt, then (if still
    // PENDING and before the order's expiry) a delayed SendMessage of the next link to the SAME
    // queue. Batch size 1, so one slow/failing check never holds up or re-drives another.
    //
    // No reserved concurrency (AWS recommends at least 5 for an SQS-triggered function; lower
    // values throttle ordinary deliveries, which then wait out the visibility timeout and count
    // towards the DLQ's maxReceiveCount). Duplicate same-seq deliveries are therefore possible and
    // may run concurrently; the chain's send-first/self-activating sequence protocol keeps them
    // from forking or corrupting it — see backend/src/lib/fast-reconcile-payment.ts.
    this.paymentReconcileProductionFastFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentReconcileProductionFastFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentReconcileProductionFastFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-reconcile-production-fast.ts'),
      environment: {
        ...productionPhonepeEnv,
        PAYMENT_RECONCILE_QUEUE_URL: productionQueue.queueUrl,
      },
    });
    props.databaseSecret.grantRead(this.paymentReconcileProductionFastFunction);
    grantPhonePeSecret(this.paymentReconcileProductionFastFunction, productionPayment.phonepeSecretName);
    // Receive/Delete/ChangeMessageVisibility (+ the event source mapping's GetQueueAttributes) on
    // this queue only, granted by the event source itself.
    this.paymentReconcileProductionFastFunction.addEventSource(
      new lambdaEventSources.SqsEventSource(productionQueue, { batchSize: 1 }),
    );
    grantProductionQueueSend(this.paymentReconcileProductionFastFunction);

    // A DLQ message means a link failed 5 times (DB/PhonePe/config problem) — that attempt's fast
    // cadence has stopped and only the 5-minute fallback still covers it. Must be seen.
    this.paymentReconcileProductionDlqAlarm = new cloudwatch.Alarm(this, 'PaymentReconcileProductionDlqAlarm', {
      alarmName: props.paymentReconcileProductionDlqAlarmName,
      alarmDescription: 'PRODUCTION PhonePe fast payment reconciliation: messages in the dead-letter queue',
      metric: this.paymentReconcileProductionDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: cloudwatch.Stats.MAXIMUM,
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // The 5-minute PRODUCTION fallback: defense in depth behind the fast chain (lost messages,
    // worker problems, attempts still open after the fast cadence stopped at expiry). No SQS access.
    this.paymentReconcileProductionFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentReconcileProductionFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentReconcileProductionFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-reconcile-production.ts'),
      timeout: cdk.Duration.minutes(4),
      environment: {
        ...productionPhonepeEnv,
        RECONCILE_BATCH_SIZE: '25',
      },
    });
    props.databaseSecret.grantRead(this.paymentReconcileProductionFunction);
    grantPhonePeSecret(this.paymentReconcileProductionFunction, productionPayment.phonepeSecretName);

    this.paymentReconcileProductionRule = new events.Rule(this, 'PaymentReconcileProductionSchedule', {
      description: 'Every 5 minutes: reconcile open PRODUCTION PhonePe payment attempts (fallback sweep)',
      schedule: events.Schedule.rate(cdk.Duration.minutes(5)),
      targets: [
        new eventsTargets.LambdaFunction(this.paymentReconcileProductionFunction, {
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(5),
        }),
      ],
    });

    // PhonePe cutover Stage 2C: the production status endpoint. Same handler code, placement and
    // timeout as PaymentStatusFunction; its entry file hard-codes PRODUCTION (only PRODUCTION
    // bookings/payment rows are ever read or reconciled) and its role reads ONLY the production
    // PhonePe secret. No SQS, no tester list (ownership is enforced per booking).
    this.paymentStatusProductionFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentStatusProductionFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentStatusProductionFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-status-production.ts'),
      environment: productionPhonepeEnv,
    });
    props.databaseSecret.grantRead(this.paymentStatusProductionFunction);
    grantPhonePeSecret(this.paymentStatusProductionFunction, productionPayment.phonepeSecretName);

    // PhonePe cutover Stage 2C: the PRODUCTION PhonePe webhook. Private-with-egress subnets + shared
    // Lambda SG (RDS over the VPC, PhonePe's order-status API over the NAT), DB secret read and
    // GetSecretValue on the production PhonePe secret ONLY — the webhook username/password are keys
    // of that same secret, read at runtime; nothing credential-like is in its environment. No SQS:
    // an authenticated callback only triggers one authoritative status check, applied through the
    // shared reconciliation path (the fast chain and the 5-minute fallback keep running regardless).
    this.paymentWebhookProductionFunction = new lambdaNodejs.NodejsFunction(this, 'PaymentWebhookProductionFunction', {
      ...paymentFunctionDefaults,
      functionName: props.paymentWebhookProductionFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/payment-webhook-production.ts'),
      environment: productionPhonepeEnv,
    });
    props.databaseSecret.grantRead(this.paymentWebhookProductionFunction);
    grantPhonePeSecret(this.paymentWebhookProductionFunction, productionPayment.phonepeSecretName);

    // Not VPC-attached, same as healthFunction: these only call Cognito's regional Admin* APIs,
    // never the database.
    const authFunctionDefaults = {
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        USER_POOL_ID: props.userPool.userPoolId,
        WEB_CLIENT_ID: props.webClient.userPoolClientId,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    };

    this.authStartFunction = new lambdaNodejs.NodejsFunction(this, 'AuthStartFunction', {
      ...authFunctionDefaults,
      functionName: props.authStartFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/auth-start.ts'),
    });
    // Scoped to exactly this one User Pool's ARN — no wildcard resource — mirroring this
    // codebase's databaseSecret.grantRead() philosophy. Cognito's CDK UserPool construct has no
    // equivalent .grant() helper for Admin* actions, so this is a hand-written PolicyStatement.
    this.authStartFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminGetUser', 'cognito-idp:AdminCreateUser', 'cognito-idp:AdminInitiateAuth'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    this.authVerifyFunction = new lambdaNodejs.NodejsFunction(this, 'AuthVerifyFunction', {
      ...authFunctionDefaults,
      functionName: props.authVerifyFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/auth-verify.ts'),
    });
    this.authVerifyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        // AdminUpdateUserAttributes: best-effort, marks email_verified=true after a successful
        // CUSTOM_CHALLENGE (see auth-verify.ts) — CUSTOM_AUTH has no built-in equivalent of what
        // native EMAIL_OTP used to do automatically as a side effect.
        actions: ['cognito-idp:AdminRespondToAuthChallenge', 'cognito-idp:AdminUpdateUserAttributes'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    this.httpApi = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: props.httpApiName,
      corsPreflight: {
        allowOrigins: props.apiConfig.corsAllowedOrigins,
        // PATCH added by Phase 3B's PATCH /admin/bookings/{id}/status.
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const cognitoAuthorizer = new apigwv2Authorizers.HttpUserPoolAuthorizer('CognitoAuthorizer', props.userPool, {
      userPoolClients: [props.webClient],
    });

    this.httpApi.addRoutes({
      path: '/health',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('HealthIntegration', this.healthFunction),
    });

    this.httpApi.addRoutes({
      path: '/products',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ProductsIntegration', this.productsFunction),
      // No authorizer: GET /products is public.
    });

    this.httpApi.addRoutes({
      path: '/bookings',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('CreateBookingIntegration', this.createBookingFunction),
      authorizer: cognitoAuthorizer,
    });

    // PhonePe cutover Stage 2A: PRODUCTION bookings. Same Cognito JWT authorizer as POST /bookings.
    this.httpApi.addRoutes({
      path: '/bookings/production',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'CreateBookingProductionIntegration',
        this.createBookingProductionFunction,
      ),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/bookings/me',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ListMyBookingsIntegration', this.listMyBookingsFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/availability',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AvailabilityIntegration', this.availabilityFunction),
      // No authorizer: public, like GET /products — a visitor can browse availability before
      // signing in.
    });

    this.httpApi.addRoutes({
      path: '/auth/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AuthStartIntegration', this.authStartFunction),
      // No authorizer: this is how an unauthenticated visitor begins signing in.
    });

    this.httpApi.addRoutes({
      path: '/auth/verify',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AuthVerifyIntegration', this.authVerifyFunction),
      // No authorizer: the caller doesn't have a token yet — this route issues the first one.
    });

    // Phase 3B: PLAY X ADMIN routes. Every one carries the same Cognito JWT authorizer as
    // POST /bookings and GET /bookings/me (proves a signed-in Cognito user is calling) plus each handler's
    // own requireAdmin() check (proves that user is in the "admin" group) — defense in depth, per
    // this phase's brief: JWT authentication alone must never be enough to reach an /admin/* route.
    this.httpApi.addRoutes({
      path: '/admin/dashboard',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminDashboardIntegration', this.adminDashboardFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/bookings',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminBookingsIntegration', this.adminBookingsFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/bookings/{id}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminBookingDetailIntegration', this.adminBookingDetailFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/bookings/{id}/status',
      methods: [apigwv2.HttpMethod.PATCH],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminBookingStatusIntegration', this.adminBookingStatusFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/payments',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminPaymentsIntegration', this.adminPaymentsFunction),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/admin/simulators',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AdminSimulatorsIntegration', this.adminSimulatorsFunction),
      authorizer: cognitoAuthorizer,
    });

    // PhonePe payments (Phase 2). Both behind the Cognito JWT authorizer; each handler additionally
    // enforces booking ownership (and, for start, the SANDBOX tester allowlist). The only webhook
    // route is Stage 2C's PRODUCTION one below.
    this.httpApi.addRoutes({
      path: '/payments/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('PaymentStartIntegration', this.paymentStartFunction),
      authorizer: cognitoAuthorizer,
    });

    // PhonePe cutover Stage 2A: PRODUCTION payment start — JWT-protected like the sandbox route.
    // Enabled in Stage 2D, but only for Cognito subs on the production tester allowlist.
    this.httpApi.addRoutes({
      path: '/payments/production/start',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'PaymentStartProductionIntegration',
        this.paymentStartProductionFunction,
      ),
      authorizer: cognitoAuthorizer,
    });

    this.httpApi.addRoutes({
      path: '/payments/{bookingId}/status',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('PaymentStatusIntegration', this.paymentStatusFunction),
      authorizer: cognitoAuthorizer,
    });

    // PhonePe cutover Stage 2C: PRODUCTION payment status — JWT-protected like the sandbox route.
    this.httpApi.addRoutes({
      path: '/payments/production/{bookingId}/status',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'PaymentStatusProductionIntegration',
        this.paymentStatusProductionFunction,
      ),
      authorizer: cognitoAuthorizer,
    });

    // PhonePe cutover Stage 2C: PhonePe's server-to-server callback for PRODUCTION orders. PUBLIC —
    // deliberately no authorizer (PhonePe holds no Cognito token); every request is authenticated
    // inside the Lambda with the SDK's validateCallback() before any payload field is trusted.
    this.httpApi.addRoutes({
      path: '/payments/production/webhook',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        'PaymentWebhookProductionIntegration',
        this.paymentWebhookProductionFunction,
      ),
    });

    new cdk.CfnOutput(this, 'UrlOutput', {
      value: this.httpApi.apiEndpoint,
      description: 'Play X HTTP API base URL',
      exportName: `${props.httpApiName}-url`,
    });
  }
}
