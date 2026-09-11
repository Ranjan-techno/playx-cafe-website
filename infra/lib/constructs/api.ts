import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { ApiConfig } from '../config/api-config';

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
 */
export class ApiConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly healthFunction: lambdaNodejs.NodejsFunction;
  public readonly productsFunction: lambdaNodejs.NodejsFunction;
  public readonly createBookingFunction: lambdaNodejs.NodejsFunction;
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
    });
    props.databaseSecret.grantRead(this.createBookingFunction);

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

    new cdk.CfnOutput(this, 'UrlOutput', {
      value: this.httpApi.apiEndpoint,
      description: 'Play X HTTP API base URL',
      exportName: `${props.httpApiName}-url`,
    });
  }
}
