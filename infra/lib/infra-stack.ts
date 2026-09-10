import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config/environment-config';
import { createResourceNamer } from './config/naming';
import { applyStandardTags } from './config/tags';
import { networkConfigs } from './config/network-config';
import { databaseConfigs } from './config/database-config';
import { authConfigs } from './config/auth-config';
import { apiConfigs } from './config/api-config';
import { NetworkConstruct } from './constructs/network';
import { DatabaseConstruct } from './constructs/database';
import { MigrationConstruct } from './constructs/migration';
import { AuthConstruct } from './constructs/auth';
import { ApiConstruct } from './constructs/api';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface InfraStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    applyStandardTags(this, props.envConfig);
    const resourceName = createResourceNamer(props.envConfig);

    // Story 2.1: networking only. PRIVATE_ISOLATED subnets, no NAT — see constructs/network.ts.
    const networkConfig = networkConfigs[props.envConfig.environmentCode];
    const network = new NetworkConstruct(this, 'Network', {
      vpcName: resourceName('vpc'),
      vpcCidr: networkConfig.vpcCidr,
      maxAzs: networkConfig.maxAzs,
    });

    // Story 2.2: RDS PostgreSQL in the Story 2.1 VPC's isolated subnets, plus the
    // Lambda/DB security-group pair and Secrets Manager credentials it needs. No Lambda
    // or API Gateway yet — see constructs/database.ts.
    const databaseConfig = databaseConfigs[props.envConfig.environmentCode];
    const database = new DatabaseConstruct(this, 'Database', {
      vpc: network.vpc,
      dbConfig: databaseConfig,
      instanceIdentifier: resourceName('db'),
      subnetGroupName: resourceName('db-subnet-group'),
      lambdaSecurityGroupName: resourceName('lambda-sg'),
      dbSecurityGroupName: resourceName('db-sg'),
      secretName: resourceName('db-credentials'),
    });

    // Story 2.3: the schema + seed data in database/migrations/, and the one-off Lambda
    // (attached to the Story 2.2 lambda security group) used to apply it manually. See
    // constructs/migration.ts for why nothing here invokes it automatically.
    const databaseSecret = database.instance.secret;
    if (!databaseSecret) {
      throw new Error('Expected the Database construct\'s instance to have a generated secret');
    }
    new MigrationConstruct(this, 'Migration', {
      vpc: network.vpc,
      lambdaSecurityGroup: database.lambdaSecurityGroup,
      databaseSecret,
      functionName: resourceName('migrate'),
    });

    // Story 2.4: Cognito User Pool + public web app client for customer signup/login. Not
    // VPC-scoped (Cognito is regional, not a VPC resource). Wired into the Story 2.6 API below
    // as the JWT authorizer's source of truth — see constructs/auth.ts.
    //
    // Guest-first passwordless auth adds the three CUSTOM_AUTH challenge trigger Lambdas
    // (DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse) that back POST
    // /auth/start and POST /auth/verify below — see constructs/auth.ts.
    const authConfig = authConfigs[props.envConfig.environmentCode];
    const auth = new AuthConstruct(this, 'Auth', {
      authConfig,
      userPoolName: resourceName('users'),
      webClientName: resourceName('web-client'),
      defineAuthChallengeFunctionName: resourceName('auth-define-challenge'),
      createAuthChallengeFunctionName: resourceName('auth-create-challenge'),
      verifyAuthChallengeFunctionName: resourceName('auth-verify-challenge'),
    });

    // Story 2.5/2.6: the backend API — an API Gateway HTTP API with a public GET /health and
    // GET /products, plus Cognito-JWT-protected POST /bookings and GET /bookings/me. The
    // booking/products Lambdas are VPC-attached (reusing the Story 2.2 lambda security group) to
    // reach the database. See constructs/api.ts and backend/src/handlers/.
    //
    // Guest-first passwordless auth adds two more public routes, POST /auth/start and
    // POST /auth/verify, driving the Story 2.4 User Pool's CUSTOM_AUTH challenge (see the Auth
    // construct above).
    //
    // Phase 2 (automated simulator availability and allocation) adds a public GET /availability,
    // backed by the new simulators/booking_allocations tables (see the Migration construct
    // above), and POST /bookings now locks and allocates real simulator inventory server-side
    // before it ever returns 201 — see backend/src/handlers/create-booking.ts and
    // backend/src/lib/allocate-simulators.ts.
    const apiConfig = apiConfigs[props.envConfig.environmentCode];
    const api = new ApiConstruct(this, 'Api', {
      apiConfig,
      httpApiName: resourceName('api'),
      healthFunctionName: resourceName('health'),
      productsFunctionName: resourceName('products'),
      createBookingFunctionName: resourceName('create-booking'),
      listMyBookingsFunctionName: resourceName('bookings-me'),
      availabilityFunctionName: resourceName('availability'),
      authStartFunctionName: resourceName('auth-start'),
      authVerifyFunctionName: resourceName('auth-verify'),
      vpc: network.vpc,
      lambdaSecurityGroup: database.lambdaSecurityGroup,
      databaseSecret,
      userPool: auth.userPool,
      webClient: auth.webClient,
    });

    // Future resources (payment, automatic machine assignment, ...) will be created here,
    // named via resourceName('...'), etc.

    // example resource
    // const queue = new sqs.Queue(this, resourceName('queue'), {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
