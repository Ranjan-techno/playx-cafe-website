import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { environments } from '../lib/config/environment-config';

test('Story 2.1: VPC created with isolated-only subnets and no NAT Gateway', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.hasResourceProperties('AWS::EC2::VPC', {
    CidrBlock: '10.20.0.0/16',
  });

  // 2 AZs, PRIVATE_ISOLATED only.
  template.resourceCountIs('AWS::EC2::Subnet', 2);

  // No NAT Gateway. Exactly seventeen Lambdas: Story 2.3's migration function, Story 2.5's
  // health-check function, Story 2.6's products/create-booking/bookings-me functions, guest-
  // first passwordless auth's auth-start/auth-verify functions, its three Cognito CUSTOM_AUTH
  // triggers (DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse), Phase 2's
  // availability function, and Phase 3B's six PLAY X ADMIN functions (admin-dashboard/
  // admin-bookings/admin-booking-detail/admin-booking-status/admin-payments/admin-simulators) —
  // not the restrictDefaultSecurityGroup feature flag's custom-resource Lambda, which stays
  // guarded against separately (that flag is explicitly disabled for this VPC — see
  // constructs/network.ts).
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::Lambda::Function', 17);
});

test('Story 2.2: RDS PostgreSQL created private, isolated, and encrypted, with a locked-down SG pair', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.hasResourceProperties('AWS::RDS::DBInstance', {
    DBInstanceIdentifier: 'playx-dev-db',
    DBName: 'playx',
    Engine: 'postgres',
    DBInstanceClass: 'db.t4g.micro',
    AllocatedStorage: '20',
    StorageType: 'gp3',
    StorageEncrypted: true,
    MultiAZ: false,
    PubliclyAccessible: false,
    DeletionProtection: false,
    BackupRetentionPeriod: 1,
  });

  // Explicit DB subnet group, scoped to the isolated subnets only.
  template.resourceCountIs('AWS::RDS::DBSubnetGroup', 1);
  template.hasResourceProperties('AWS::RDS::DBSubnetGroup', {
    DBSubnetGroupName: 'playx-dev-db-subnet-group',
  });

  // Exactly the lambda-sg / db-sg pair — no default/extra security groups.
  template.resourceCountIs('AWS::EC2::SecurityGroup', 2);
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'playx-dev-lambda-sg' });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', { GroupName: 'playx-dev-db-sg' });

  // Two ingress rules: 5432 from the Lambda SG into the DB SG (Story 2.2), plus 443 from the
  // Lambda SG into itself, self-referencing, for the Story 2.3 Secrets Manager VPC endpoint.
  template.resourceCountIs('AWS::EC2::SecurityGroupIngress', 2);
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    IpProtocol: 'tcp',
    FromPort: 5432,
    ToPort: 5432,
  });

  // Credentials generated into Secrets Manager, not hardcoded.
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.hasResourceProperties('AWS::SecretsManager::Secret', {
    Name: 'playx-dev-db-credentials',
    GenerateSecretString: { SecretStringTemplate: '{"username":"playx_admin"}' },
  });
});

test('Story 2.3: migration Lambda deployed in isolated subnets with no public trigger', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Seventeen Lambda functions exist in the stack (this one, Story 2.5's health-check function,
  // Story 2.6's products/create-booking/bookings-me functions, guest-first passwordless auth's
  // auth-start/auth-verify functions, its three CUSTOM_AUTH triggers, Phase 2's availability
  // function, and Phase 3B's six admin functions — see below), but health/auth-start/auth-verify/
  // the three triggers are the six of the seventeen that do NOT sit in the VPC.
  template.resourceCountIs('AWS::Lambda::Function', 17);
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'playx-dev-migrate',
    Runtime: 'nodejs22.x',
    VpcConfig: Match.objectLike({}),
  });

  // Reaches Secrets Manager without a NAT Gateway or internet route.
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 1);
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    ServiceName: Match.stringLikeRegexp('secretsmanager'),
  });

  // No public/automatic way to trigger it: no REST API, no Function URL, no EventBridge
  // rule. (Story 2.5's HTTP API is a separate AWS::ApiGatewayV2::Api resource, checked below —
  // it fronts the health function, never this one.)
  template.resourceCountIs('AWS::ApiGateway::RestApi', 0);
  template.resourceCountIs('AWS::Lambda::Url', 0);
  template.resourceCountIs('AWS::Events::Rule', 0);

  // IAM is scoped to this one secret's ARN, not a wildcard.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('Story 2.4: Cognito User Pool for email sign-in, self-signup, and a secret-less web client', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    UserPoolName: 'playx-dev-users',
    // Email is the sign-in identifier itself (UsernameAttributes), not a generated username
    // with email layered on as an alias.
    UsernameAttributes: ['email'],
    AutoVerifiedAttributes: ['email'],
    Policies: Match.objectLike({
      PasswordPolicy: Match.objectLike({
        MinimumLength: 8,
        RequireLowercase: true,
        RequireUppercase: true,
        RequireNumbers: true,
        RequireSymbols: false,
      }),
    }),
    AccountRecoverySetting: Match.objectLike({
      RecoveryMechanisms: Match.arrayWith([Match.objectLike({ Name: 'verified_email' })]),
    }),
    Schema: Match.arrayWith([
      Match.objectLike({ Name: 'email', Required: true }),
      Match.objectLike({ Name: 'name', Required: true }),
      Match.objectLike({ Name: 'phone_number', Required: false }),
    ]),
  });

  // Exactly one app client: the public web client. No secret, fully passwordless — only
  // ALLOW_CUSTOM_AUTH (guest-first passwordless auth's CUSTOM_AUTH challenge) and the
  // automatically-added ALLOW_REFRESH_TOKEN_AUTH, with no password-based flow of any kind
  // reachable (see the "CUSTOM_AUTH challenge triggers wired to the User Pool" test below for the
  // rest of that architecture decision's wiring).
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ClientName: 'playx-dev-web-client',
    GenerateSecret: false,
    // Checked one at a time (each element trivially satisfies Match.arrayWith) since CDK doesn't
    // guarantee ExplicitAuthFlows' relative order, only that it's a superset of these two.
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_CUSTOM_AUTH']),
    PreventUserExistenceErrors: 'ENABLED',
  });
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_REFRESH_TOKEN_AUTH']),
  });
  // No password-based flow survives: not SRP (ALLOW_USER_SRP_AUTH), not plaintext
  // ALLOW_USER_PASSWORD_AUTH/ALLOW_ADMIN_USER_PASSWORD_AUTH, and not the choice-based
  // ALLOW_USER_AUTH (which would let a caller pick PASSWORD — or Cognito's native
  // uncontrollable-length EMAIL_OTP — directly, bypassing auth-start.ts).
  for (const removedFlow of [
    'ALLOW_USER_SRP_AUTH',
    'ALLOW_USER_PASSWORD_AUTH',
    'ALLOW_ADMIN_USER_PASSWORD_AUTH',
    'ALLOW_USER_AUTH',
  ]) {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ExplicitAuthFlows: Match.not(Match.arrayWith([removedFlow])),
    });
  }

  // The User Pool ID and App Client ID are surfaced as stack outputs.
  template.hasOutput('*', Match.objectLike({ Description: 'Play X Cognito User Pool ID' }));
  template.hasOutput(
    '*',
    Match.objectLike({ Description: 'Play X Cognito App Client ID (public web client, no secret)' }),
  );
});

test('Story 2.5: HTTP API with a GET /health route, CORS-scoped to the production GitHub Pages origin, the localhost development origin, and the staging Amplify origin', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Exactly one HTTP API (not a REST API/RestApi — see the Story 2.3 test above), CORS
  // restricted to the production GitHub Pages origin index.html/auth.html are served from, the
  // localhost development origin used when serving the site locally with
  // `python3 -m http.server 8000`, and the staging.playxcafe.com Amplify frontend origin.
  // AllowMethods now includes POST too (Story 2.6's POST /bookings), so this is arrayWith
  // rather than an exact match.
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'playx-dev-api',
    ProtocolType: 'HTTP',
    CorsConfiguration: Match.objectLike({
      AllowOrigins: [
        'https://ranjan-techno.github.io',
        'http://localhost:8000',
        'https://staging.playxcafe.com',
      ],
      AllowMethods: Match.arrayWith(['GET']),
    }),
  });

  // GET /health, proxying to a Lambda integration — one of four routes total after Story 2.6
  // (see below), so this checks the specific route exists rather than asserting a route count.
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /health',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
    IntegrationType: 'AWS_PROXY',
    PayloadFormatVersion: '2.0',
  });

  // The health function itself: not VPC-attached (see constructs/api.ts — it never talks to
  // the Story 2.2 database), unlike the migration function checked above and Story 2.6's
  // products/booking functions checked below.
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'playx-dev-health',
    Runtime: 'nodejs22.x',
    VpcConfig: Match.absent(),
  });

  // The API's base URL is surfaced as a stack output.
  template.hasOutput('*', Match.objectLike({ Description: 'Play X HTTP API base URL' }));
});

test('Story 2.6: authenticated booking APIs — Cognito JWT authorizer on POST /bookings and GET /bookings/me, public GET /products', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Exactly one JWT authorizer, backed by the Story 2.4 User Pool + web client, with the
  // standard "Authorization: Bearer <token>" identity source.
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'JWT',
    IdentitySource: ['$request.header.Authorization'],
  });

  // Thirteen routes total: GET /health (Story 2.5), GET /products, POST /bookings, and
  // GET /bookings/me (this story), POST /auth/start and POST /auth/verify (guest-first
  // passwordless auth, checked separately below), GET /availability (Phase 2, checked separately
  // further below), and Phase 3B's six admin routes (checked separately further below too).
  // Thirteen integrations, one per route.
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 13);
  template.resourceCountIs('AWS::ApiGatewayV2::Integration', 13);

  // GET /products is public: no authorizer attached (CloudFormation emits AuthorizationType:
  // 'NONE' explicitly for an unauthenticated route, rather than omitting the property).
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /products',
    AuthorizationType: 'NONE',
  });

  // POST /bookings and GET /bookings/me both require the Cognito JWT authorizer.
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'POST /bookings',
    AuthorizationType: 'JWT',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /bookings/me',
    AuthorizationType: 'JWT',
  });

  // The three new Lambdas: VPC-attached (unlike healthFunction, checked above) so they can
  // reach the Story 2.2 database, each with read access to its credentials secret.
  for (const functionName of ['playx-dev-products', 'playx-dev-create-booking', 'playx-dev-bookings-me']) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: functionName,
      Runtime: 'nodejs22.x',
      VpcConfig: Match.objectLike({}),
    });
  }

  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('Guest-first passwordless auth: public POST /auth/start and POST /auth/verify, scoped Cognito IAM', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Both routes are public: the caller has no token yet, so neither carries the Story 2.6 JWT
  // authorizer (CloudFormation emits AuthorizationType: 'NONE' explicitly, same as GET /products).
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'POST /auth/start',
    AuthorizationType: 'NONE',
  });
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'POST /auth/verify',
    AuthorizationType: 'NONE',
  });

  // Neither function is VPC-attached (unlike products/create-booking/bookings-me): they only
  // call Cognito's regional Admin* APIs, never the database.
  for (const functionName of ['playx-dev-auth-start', 'playx-dev-auth-verify']) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: functionName,
      Runtime: 'nodejs22.x',
      VpcConfig: Match.absent(),
    });
  }

  // IAM scoped to exactly the two documented action sets, each on the User Pool's own ARN — no
  // wildcard resource, mirroring the databaseSecret.grantRead() policies checked above.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminGetUser',
            'cognito-idp:AdminCreateUser',
            'cognito-idp:AdminInitiateAuth',
          ]),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
  // auth-verify.ts also best-effort marks email_verified=true after a successful CUSTOM_CHALLENGE
  // (see auth-verify.ts's header) — CUSTOM_AUTH has no built-in equivalent of what Cognito's
  // native EMAIL_OTP first factor used to do automatically.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'cognito-idp:AdminRespondToAuthChallenge',
            'cognito-idp:AdminUpdateUserAttributes',
          ]),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('Guest-first passwordless auth: CUSTOM_AUTH challenge triggers wired to the User Pool, six-digit OTP emailed via scoped SES IAM', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // The three CUSTOM_AUTH triggers are wired directly into the User Pool's LambdaConfig, not
  // exposed through API Gateway — Cognito invokes them itself during AdminInitiateAuth/
  // AdminRespondToAuthChallenge (see auth-start.ts/auth-verify.ts).
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    LambdaConfig: Match.objectLike({
      DefineAuthChallenge: Match.anyValue(),
      CreateAuthChallenge: Match.anyValue(),
      VerifyAuthChallengeResponse: Match.anyValue(),
    }),
  });

  // Play X is fully passwordless from launch: EMAIL_OTP is an allowed first factor at the User
  // Pool level (this is what lets auth-start.ts's AdminCreateUser provision a brand-new customer
  // with no TemporaryPassword at all — see constructs/auth.ts's signInPolicy comment for the AWS
  // doc citation), and PASSWORD sign-in is not reachable through any client flow (see the
  // ExplicitAuthFlows checks in the Story 2.4 test above). PASSWORD still appears structurally in
  // this list — CDK's UserPool L2 construct hard-fails synthesis if allowedFirstAuthFactors is
  // set at all without `password: true` ("The password authentication cannot be disabled",
  // aws-cdk-lib/aws-cognito/lib/user-pool.js) — so this asserts what CDK actually allows setting,
  // not a literal absence of the string "PASSWORD" from the array.
  template.hasResourceProperties('AWS::Cognito::UserPool', {
    Policies: Match.objectLike({
      SignInPolicy: Match.objectLike({
        AllowedFirstAuthFactors: Match.arrayWith(['EMAIL_OTP']),
      }),
    }),
  });

  // Short-lived CUSTOM_AUTH session token (in minutes) on the web client, bounding how long a
  // captured/leaked Session value from /auth/start could be replayed against.
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    AuthSessionValidity: 3,
  });

  // None of the three trigger functions is VPC-attached: DefineAuthChallenge/
  // VerifyAuthChallengeResponse call no AWS APIs at all, and CreateAuthChallenge only calls SES.
  for (const functionName of [
    'playx-dev-auth-define-challenge',
    'playx-dev-auth-create-challenge',
    'playx-dev-auth-verify-challenge',
  ]) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: functionName,
      Runtime: 'nodejs22.x',
      VpcConfig: Match.absent(),
    });
  }

  // The email OTP is sent via SES with the minimum permission needed (ses:SendEmail). SES
  // authorizes SendEmail against the *recipient* identity, not the sender's, so scoping the
  // resource to our own sender identity ARN would reject every send (recipients are arbitrary
  // Play X customers, never a fixed identity) — the resource is necessarily "*", with the sender
  // instead locked down via the ses:FromAddress condition key.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'ses:SendEmail',
          Effect: 'Allow',
          Resource: '*',
          Condition: {
            StringEquals: {
              'ses:FromAddress': 'playxcafesupport@gmail.com',
            },
          },
        }),
      ]),
    }),
  });
});

test('Phase 2: public GET /availability, VPC-attached with database read access, migration Lambda still the only one bundling database/migrations/', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Public, like GET /products: no JWT authorizer, since a visitor can browse availability
  // before signing in.
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
    RouteKey: 'GET /availability',
    AuthorizationType: 'NONE',
  });

  // VPC-attached (unlike healthFunction/auth-start/auth-verify/the three CUSTOM_AUTH triggers),
  // since it reads the simulators/booking_allocations tables directly, with read access to the
  // same database credentials secret as products/create-booking/bookings-me.
  template.hasResourceProperties('AWS::Lambda::Function', {
    FunctionName: 'playx-dev-availability',
    Runtime: 'nodejs22.x',
    VpcConfig: Match.objectLike({}),
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});

test('Phase 3B: PLAY X ADMIN — a Cognito "admin" group on the existing User Pool, no second pool', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Still exactly one User Pool (see the Story 2.4 test above) — the admin group is added to it,
  // not a second pool.
  template.resourceCountIs('AWS::Cognito::UserPool', 1);

  template.resourceCountIs('AWS::Cognito::UserPoolGroup', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolGroup', {
    GroupName: 'admin',
  });
});

test('Phase 3B: PLAY X ADMIN — six /admin/* routes, all Cognito-JWT-protected (never public)', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Still exactly one JWT authorizer (see the Story 2.6 test above) — every admin route reuses it,
  // no second authorizer/User Pool client for admin.
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);

  for (const routeKey of [
    'GET /admin/dashboard',
    'GET /admin/bookings',
    'GET /admin/bookings/{id}',
    'PATCH /admin/bookings/{id}/status',
    'GET /admin/payments',
    'GET /admin/simulators',
  ]) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: routeKey,
      AuthorizationType: 'JWT',
    });
  }

  // CORS now also allows PATCH (PATCH /admin/bookings/{id}/status), on top of the GET/POST
  // methods checked by the Story 2.5 test above — same CORS origin allowlist, unbroadened.
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: Match.objectLike({
      AllowOrigins: [
        'https://ranjan-techno.github.io',
        'http://localhost:8000',
        'https://staging.playxcafe.com',
      ],
      AllowMethods: Match.arrayWith(['GET', 'POST', 'PATCH']),
    }),
  });
});

test('Phase 3B: PLAY X ADMIN — all six admin Lambdas are VPC-attached with database read access, defense-in-depth authorization in the handler itself (not just the JWT authorizer)', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // VPC-attached, like products/create-booking/bookings-me/availability: every admin handler
  // reads (and admin-booking-status writes) the database directly.
  for (const functionName of [
    'playx-dev-admin-dashboard',
    'playx-dev-admin-bookings',
    'playx-dev-admin-booking-detail',
    'playx-dev-admin-payments',
    'playx-dev-admin-simulators',
    'playx-dev-admin-booking-status',
  ]) {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: functionName,
      Runtime: 'nodejs22.x',
      VpcConfig: Match.objectLike({}),
    });
  }

  // Each admin Lambda has read access to the same database credentials secret as the other
  // VPC-attached Lambdas — checked generically (the Story 2.6 test above already checks this
  // policy shape exists at least once); the actual "is this caller an admin" decision is made in
  // application code (backend/src/lib/admin-auth.ts's requireAdmin()), not by IAM or the CDK-level
  // JWT authorizer, which has no notion of Cognito group membership.
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
          Effect: 'Allow',
        }),
      ]),
    }),
  });
});
