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
  /** Full resource name for the passwordless auth-start Lambda, e.g. 'playx-dev-auth-start'. */
  authStartFunctionName: string;
  /** Full resource name for the passwordless auth-verify Lambda, e.g. 'playx-dev-auth-verify'. */
  authVerifyFunctionName: string;

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
 */
export class ApiConstruct extends Construct {
  public readonly httpApi: apigwv2.HttpApi;
  public readonly healthFunction: lambdaNodejs.NodejsFunction;
  public readonly productsFunction: lambdaNodejs.NodejsFunction;
  public readonly createBookingFunction: lambdaNodejs.NodejsFunction;
  public readonly listMyBookingsFunction: lambdaNodejs.NodejsFunction;
  public readonly authStartFunction: lambdaNodejs.NodejsFunction;
  public readonly authVerifyFunction: lambdaNodejs.NodejsFunction;

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
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST],
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

    new cdk.CfnOutput(this, 'UrlOutput', {
      value: this.httpApi.apiEndpoint,
      description: 'Play X HTTP API base URL',
      exportName: `${props.httpApiName}-url`,
    });
  }
}
