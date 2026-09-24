import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { environments } from '../lib/config/environment-config';

test('Story 2.1 (+ payments egress): VPC keeps its isolated subnets and adds NAT-backed egress subnets', () => {
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

  // 2 AZs x (private-isolated [original] + public [NAT host only] + private-egress [payments]).
  template.resourceCountIs('AWS::EC2::Subnet', 6);

  // Exactly ONE NAT Gateway (MVP cost control, payments egress only). Exactly twenty-two Lambdas: Story 2.3's migration function, Story 2.5's
  // health-check function, Story 2.6's products/create-booking/bookings-me functions, guest-
  // first passwordless auth's auth-start/auth-verify functions, its three Cognito CUSTOM_AUTH
  // triggers (DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse), Phase 2's
  // availability function, and Phase 3B's six PLAY X ADMIN functions (admin-dashboard/
  // admin-bookings/admin-booking-detail/admin-booking-status/admin-payments/admin-simulators),
  // the PhonePe payment start/status/reconcile functions, and PhonePe cutover Stage 2A's
  // create-booking-production/payment-start-production functions, and Stage 2B's
  // payment-reconcile-production-fast/payment-reconcile-production functions, and Stage 2C's
  // payment-status-production/payment-webhook-production functions — not the restrictDefaultSecurityGroup feature flag's custom-resource Lambda, which stays
  // guarded against separately (that flag is explicitly disabled for this VPC — see
  // constructs/network.ts).
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  template.resourceCountIs('AWS::Lambda::Function', 26);
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

  // Nineteen Lambda functions exist in the stack (this one, Story 2.5's health-check function,
  // Story 2.6's products/create-booking/bookings-me functions, guest-first passwordless auth's
  // auth-start/auth-verify functions, its three CUSTOM_AUTH triggers, Phase 2's availability
  // function, Phase 3B's six admin functions, the three PhonePe payment functions, Stage 2A's
  // two production functions, Stage 2B's two production reconcile functions and Stage 2C's
  // production status + webhook functions — see below), but health/auth-start/auth-verify/the three
  // triggers are the six of the twenty-six that do NOT sit in the VPC.
  template.resourceCountIs('AWS::Lambda::Function', 26);
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
  // The only EventBridge rule is Phase 5A's payment-reconcile schedule (asserted below) — it must
  // never target the migration function.
  for (const rule of Object.values<Record<string, any>>(template.toJSON().Resources).filter((r) => r.Type === 'AWS::Events::Rule')) {
    assert.ok(!JSON.stringify(rule.Properties.Targets).includes('Migration'), 'no rule targets the migration Lambda');
  }

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

test('Story 2.5: HTTP API with a GET /health route, CORS-scoped to the production GitHub Pages origin, the localhost development origin, the staging frontend origin, and the production playxcafe.com/www.playxcafe.com origins', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Exactly one HTTP API (not a REST API/RestApi — see the Story 2.3 test above), CORS
  // restricted to the production GitHub Pages origin index.html/auth.html are served from, the
  // localhost development origin used when serving the site locally with
  // `python3 -m http.server 8000`, the staging.playxcafe.com GitHub Pages frontend origin, and the
  // production playxcafe.com apex and www domains. AllowMethods now includes POST too (Story
  // 2.6's POST /bookings), so this is arrayWith rather than an exact match.
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'playx-dev-api',
    ProtocolType: 'HTTP',
    CorsConfiguration: Match.objectLike({
      AllowOrigins: [
        'https://ranjan-techno.github.io',
        'http://localhost:8000',
        'https://staging.playxcafe.com',
        'https://playxcafe.com',
        'https://www.playxcafe.com',
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

  // Nineteen routes total (incl. PhonePe Phase 2's two payment routes, Stage 2A's POST
  // /bookings/production + POST /payments/production/start and Stage 2C's GET
  // /payments/production/{bookingId}/status + public POST /payments/production/webhook, checked
  // below): GET /health (Story 2.5), GET /products, POST /bookings, and
  // GET /bookings/me (this story), POST /auth/start and POST /auth/verify (guest-first
  // passwordless auth, checked separately below), GET /availability (Phase 2, checked separately
  // further below), and Phase 3B's six admin routes (checked separately further below too).
  // Nineteen integrations, one per route.
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 19);
  template.resourceCountIs('AWS::ApiGatewayV2::Integration', 19);

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

  // Cognito sends through the verified SES DOMAIN identity (playxcafe.com), not a separate
  // bookings@playxcafe.com email identity, which is not verified in SES.
  const pools = template.findResources('AWS::Cognito::UserPool');
  const emailConfig = Object.values(pools)[0].Properties.EmailConfiguration;
  expect(emailConfig.From).toBe('Play X Cafe <bookings@playxcafe.com>');
  expect(emailConfig.ReplyToEmailAddress).toBe('bookings@playxcafe.com');
  expect(emailConfig.EmailSendingAccount).toBe('DEVELOPER');
  const sourceArn = JSON.stringify(emailConfig.SourceArn);
  expect(sourceArn).toContain(':ses:ap-south-1:');
  expect(sourceArn).toContain('AWS::AccountId');
  expect(sourceArn).toContain(':identity/playxcafe.com');
  expect(sourceArn).not.toContain('identity/bookings@playxcafe.com');

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
              'ses:FromAddress': 'bookings@playxcafe.com',
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
        'https://playxcafe.com',
        'https://www.playxcafe.com',
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

// ---------------------------------------------------------------------------------------------
// PhonePe Phase 2: payment Lambdas, NAT egress, PhonePe secret IAM, payment routes.
// ---------------------------------------------------------------------------------------------

type Json = Record<string, any>;

function synth(context?: Record<string, string>): { template: Template; json: Json } {
  const app = new cdk.App(context ? { context } : undefined);
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);
  return { template, json: template.toJSON() };
}

const PAYMENT_FUNCTIONS = [
  'playx-dev-payment-start',
  'playx-dev-payment-status',
  'playx-dev-payment-reconcile',
  'playx-dev-payment-start-production',
  'playx-dev-payment-reconcile-production-fast',
  'playx-dev-payment-reconcile-production',
  'playx-dev-payment-status-production',
  'playx-dev-payment-webhook-production',
];

/** The two 5-minute scheduled reconcilers (4-minute timeout); every other payment Lambda is 25s. */
const SCHEDULED_RECONCILERS = ['playx-dev-payment-reconcile', 'playx-dev-payment-reconcile-production'];

/** Which one PhonePe secret each payment Lambda may read. */
const PHONEPE_SECRET_BY_FUNCTION: Record<string, string> = {
  'playx-dev-payment-start': 'playx/phonepe/sandbox',
  'playx-dev-payment-status': 'playx/phonepe/sandbox',
  'playx-dev-payment-reconcile': 'playx/phonepe/sandbox',
  'playx-dev-payment-start-production': 'playx/phonepe/production',
  'playx-dev-payment-reconcile-production-fast': 'playx/phonepe/production',
  'playx-dev-payment-reconcile-production': 'playx/phonepe/production',
  'playx-dev-payment-status-production': 'playx/phonepe/production',
  'playx-dev-payment-webhook-production': 'playx/phonepe/production',
};

function lambdaEntries(json: Json): [string, Json][] {
  return Object.entries<Json>(json.Resources).filter(([, r]) => r.Type === 'AWS::Lambda::Function');
}

/** Every IAM statement attached (via IAM::Policy) to the role of the named Lambda. */
function statementsFor(json: Json, functionName: string): Json[] {
  const fn = lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === functionName);
  assert.ok(fn, `Lambda ${functionName} exists`);
  const roleId = fn[1].Properties.Role['Fn::GetAtt'][0];
  return Object.values<Json>(json.Resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy' && r.Properties.Roles.some((role: Json) => role.Ref === roleId))
    .flatMap((r) => [r.Properties.PolicyDocument.Statement].flat());
}

/** Any statement touching ANY PhonePe secret (sandbox, production, or a playx/phonepe/* pattern). */
function isPhonePeSecretStatement(statement: Json): boolean {
  return JSON.stringify(statement.Resource).includes('playx/phonepe/');
}

test('PhonePe Phase 2: existing VPC/subnets/RDS/Cognito/API keep their logical IDs and shape (nothing replaced)', () => {
  const { template, json } = synth();
  const ids = Object.keys(json.Resources);
  for (const id of [
    'NetworkVpc7FB7348F',
    'NetworkVpcprivateisolatedSubnet1SubnetACC755DD',
    'NetworkVpcprivateisolatedSubnet2SubnetBCE28083',
    'DatabaseInstanceAA8A5FDE',
    'AuthUserPool8115E87F',
  ]) {
    assert.ok(ids.includes(id), `${id} still exists under the same logical ID`);
  }
  // Same CIDRs as the deployed isolated subnets: the new groups were appended, not interleaved.
  assert.equal(json.Resources.NetworkVpcprivateisolatedSubnet1SubnetACC755DD.Properties.CidrBlock, '10.20.0.0/24');
  assert.equal(json.Resources.NetworkVpcprivateisolatedSubnet2SubnetBCE28083.Properties.CidrBlock, '10.20.1.0/24');
  assert.equal(json.Resources.NetworkVpc7FB7348F.Properties.CidrBlock, '10.20.0.0/16');
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  // RDS stays isolated: its subnet group is exactly the two original isolated subnets.
  const subnetGroup = Object.values<Json>(json.Resources).find((r) => r.Type === 'AWS::RDS::DBSubnetGroup');
  assert.deepEqual(
    subnetGroup?.Properties.SubnetIds.map((s: Json) => s.Ref).sort(),
    ['NetworkVpcprivateisolatedSubnet1SubnetACC755DD', 'NetworkVpcprivateisolatedSubnet2SubnetBCE28083'],
  );
  // The isolated route tables gained no internet/NAT route.
  for (const route of Object.values<Json>(json.Resources).filter((r) => r.Type === 'AWS::EC2::Route')) {
    const table = route.Properties.RouteTableId.Ref as string;
    assert.ok(!table.includes('privateisolated'), `${table} must stay routeless`);
  }
});

test('PhonePe Phase 2: one NAT Gateway in a public subnet; private-egress subnets default-route through it', () => {
  const { template, json } = synth();
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  template.resourceCountIs('AWS::EC2::InternetGateway', 1);
  const nat = Object.values<Json>(json.Resources).find((r) => r.Type === 'AWS::EC2::NatGateway');
  assert.ok(String(nat?.Properties.SubnetId.Ref).includes('public'), 'NAT lives in a public subnet');
  const natRoutes = Object.entries<Json>(json.Resources).filter(([, r]) => r.Type === 'AWS::EC2::Route' && r.Properties.NatGatewayId);
  assert.equal(natRoutes.length, 2, 'both private-egress subnets route via the single NAT');
  for (const [, route] of natRoutes) {
    assert.equal(route.Properties.DestinationCidrBlock, '0.0.0.0/0');
    assert.ok(String(route.Properties.RouteTableId.Ref).includes('privateegress'));
  }
});

test('PhonePe Phase 2: payment Lambdas use private-with-egress subnets and the shared Lambda security group; all other VPC Lambdas stay isolated', () => {
  const { json } = synth();
  const lambdaSg = Object.entries<Json>(json.Resources).find(
    ([, r]) => r.Type === 'AWS::EC2::SecurityGroup' && r.Properties.GroupName === 'playx-dev-lambda-sg',
  )?.[0];
  for (const [, fn] of lambdaEntries(json)) {
    const vpc = fn.Properties.VpcConfig;
    if (!vpc) continue;
    const subnets: string[] = vpc.SubnetIds.map((s: Json) => s.Ref);
    if (PAYMENT_FUNCTIONS.includes(fn.Properties.FunctionName)) {
      assert.equal(subnets.length, 2);
      assert.ok(subnets.every((s) => s.includes('privateegress')), `${fn.Properties.FunctionName} on egress subnets`);
      assert.deepEqual(vpc.SecurityGroupIds, [{ 'Fn::GetAtt': [lambdaSg, 'GroupId'] }], 'shared lambda-sg => RDS reachable');
    } else {
      assert.ok(subnets.every((s) => s.includes('privateisolated')), `${fn.Properties.FunctionName} not moved`);
    }
  }
  for (const name of PAYMENT_FUNCTIONS) {
    const fn = lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === name)?.[1];
    assert.equal(fn?.Properties.Timeout, SCHEDULED_RECONCILERS.includes(name) ? 240 : 25);
    assert.equal(fn?.Properties.Runtime, 'nodejs22.x');
  }
});

test('PhonePe Phase 2: ONLY the payment Lambdas can read a PhonePe secret, each with GetSecretValue on exactly its one secret', () => {
  const { json } = synth();
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    const phonepe = statementsFor(json, name).filter(isPhonePeSecretStatement);
    if (PAYMENT_FUNCTIONS.includes(name)) {
      assert.equal(phonepe.length, 1, `${name} has the PhonePe grant`);
      assert.equal(phonepe[0].Effect, 'Allow');
      assert.equal(phonepe[0].Action, 'secretsmanager:GetSecretValue', 'GetSecretValue only');
      const arn = JSON.stringify(phonepe[0].Resource);
      assert.ok(arn.includes(`secret:${PHONEPE_SECRET_BY_FUNCTION[name]}-??????`), `${name}: scoped to its one secret (name + random suffix)`);
      assert.ok(!arn.includes('"*"') && !arn.includes('secret:*'));
    } else {
      assert.equal(phonepe.length, 0, `${name} must NOT be able to read any PhonePe secret`);
    }
  }
  // No stack-wide wildcard grant on Secrets Manager either.
  for (const r of Object.values<Json>(json.Resources).filter((x) => x.Type === 'AWS::IAM::Policy')) {
    for (const st of [r.Properties.PolicyDocument.Statement].flat()) {
      if (JSON.stringify(st.Action).includes('secretsmanager')) {
        assert.notEqual(st.Resource, '*');
      }
    }
  }
});

test('PhonePe Phase 2: the PhonePe secret is referenced, never created, and no credential is in the template', () => {
  const { template, json } = synth();
  // Still just the RDS credentials secret from Story 2.2.
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  const text = JSON.stringify(json);
  // (Stage 2C: "webhook" now legitimately appears in a function name and a route path — but no
  // credential key or value, in any casing, ever does.)
  assert.ok(!/client_?secret|webhook_?password|webhook_?username|webhook_?user\b|webhook_?pass\b/i.test(text));
});

test('PhonePe Phase 2: payment Lambda environment — config wired, sandbox testers fail closed by default', () => {
  const { json } = synth();
  const env = (name: string) =>
    lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === name)?.[1].Properties.Environment.Variables as Json;
  const start = env('playx-dev-payment-start');
  assert.equal(start.PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox');
  assert.equal(start.PHONEPE_ENVIRONMENT, 'SANDBOX');
  assert.equal(start.PAYMENT_CHECKOUT_HOLD_MINUTES, '20');
  assert.equal(start.PAYMENT_RETURN_URL, 'https://staging.playxcafe.com/payment-return.html');
  assert.equal(start.PHONEPE_SANDBOX_TESTERS, '', 'no tester configured => backend denies every start');
  const status = env('playx-dev-payment-status');
  assert.equal(status.PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox');
  assert.equal(status.PHONEPE_SANDBOX_TESTERS, undefined, 'status does not need the tester list');
  // No other Lambda gets any PhonePe configuration — except (Stage 2C) the production booking
  // Lambda's PHONEPE_PRODUCTION_TESTERS allowlist, which is not PhonePe configuration.
  for (const [, fn] of lambdaEntries(json)) {
    if (PAYMENT_FUNCTIONS.includes(fn.Properties.FunctionName)) continue;
    const vars = { ...(fn.Properties.Environment?.Variables ?? {}) };
    if (fn.Properties.FunctionName === 'playx-dev-create-booking-production') delete vars.PHONEPE_PRODUCTION_TESTERS;
    assert.ok(!JSON.stringify(vars).includes('PHONEPE'), fn.Properties.FunctionName);
  }
});

test('PhonePe Phase 2: sandbox testers come from deploy-time context, trimmed; blank stays empty', () => {
  const configured = synth({ phonepeSandboxTesters: ' sub-1 , tester@example.com ,, ' });
  const env = lambdaEntries(configured.json).find(([, r]) => r.Properties.FunctionName === 'playx-dev-payment-start')?.[1].Properties
    .Environment.Variables;
  assert.equal(env.PHONEPE_SANDBOX_TESTERS, 'sub-1,tester@example.com');
  const blank = synth({ phonepeSandboxTesters: '   ' });
  const blankEnv = lambdaEntries(blank.json).find(([, r]) => r.Properties.FunctionName === 'playx-dev-payment-start')?.[1].Properties
    .Environment.Variables;
  assert.equal(blankEnv.PHONEPE_SANDBOX_TESTERS, '');
});

test('PhonePe Phase 2: POST /payments/start and GET /payments/{bookingId}/status are JWT-protected; the only webhook route is Stage 2C\'s production one', () => {
  const { template, json } = synth();
  const authorizerId = Object.entries<Json>(json.Resources).find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Authorizer')?.[0];
  for (const routeKey of ['POST /payments/start', 'GET /payments/{bookingId}/status']) {
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: routeKey,
      AuthorizationType: 'JWT',
      AuthorizerId: { Ref: authorizerId },
    });
  }
  const routeKeys = Object.values<Json>(json.Resources)
    .filter((r) => r.Type === 'AWS::ApiGatewayV2::Route')
    .map((r) => r.Properties.RouteKey as string);
  assert.deepEqual(routeKeys.filter((k) => /webhook|callback/i.test(k)), ['POST /payments/production/webhook']);
  // + Stage 2A's POST /payments/production/start and Stage 2C's production status + webhook
  // (checked in their own tests below).
  assert.equal(routeKeys.filter((k) => /^\w+ \/payments/.test(k)).length, 5);
  // CORS unchanged: same origins, same methods/headers.
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    CorsConfiguration: Match.objectLike({
      AllowMethods: ['GET', 'POST', 'PATCH'],
      AllowHeaders: ['Content-Type', 'Authorization'],
      AllowOrigins: [
        'https://ranjan-techno.github.io',
        'http://localhost:8000',
        'https://staging.playxcafe.com',
        'https://playxcafe.com',
        'https://www.playxcafe.com',
      ],
    }),
  });
});

test('Phase 5A: payment reconciliation runs on an EventBridge schedule every 5 minutes, targeting only the reconcile Lambda, with no retries', () => {
  const { template, json } = synth();
  // The sandbox rule + (Stage 2B) the separate PRODUCTION fallback rule.
  template.resourceCountIs('AWS::Events::Rule', 2);
  const reconcile = lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === 'playx-dev-payment-reconcile')!;
  const [ruleId, rule] = Object.entries<Json>(json.Resources).find(
    ([, r]) => r.Type === 'AWS::Events::Rule' && r.Properties.Targets.some((t: Json) => t.Arn['Fn::GetAtt']?.[0] === reconcile[0]),
  )!;
  assert.ok(ruleId.startsWith('ApiPaymentReconcileSchedule'), 'the sandbox rule keeps its logical id');
  assert.equal(rule.Properties.ScheduleExpression, 'rate(5 minutes)');
  assert.equal(rule.Properties.State, 'ENABLED');
  assert.equal(rule.Properties.Targets.length, 1);
  const target = rule.Properties.Targets[0];
  assert.equal(target.RetryPolicy.MaximumRetryAttempts, 0);
  assert.deepEqual(target.Arn, { 'Fn::GetAtt': [reconcile[0], 'Arn'] });

  // Only this rule may invoke the sandbox reconciler.
  const permissions = Object.values<Json>(json.Resources).filter(
    (r) =>
      r.Type === 'AWS::Lambda::Permission' &&
      r.Properties.Principal === 'events.amazonaws.com' &&
      JSON.stringify(r.Properties.FunctionName).includes(reconcile[0]),
  );
  assert.equal(permissions.length, 1);
  assert.deepEqual(permissions[0].Properties.SourceArn, { 'Fn::GetAtt': [ruleId, 'Arn'] });
});

test('Phase 5A: the reconcile Lambda has only DB-secret read + GetSecretValue on the one PhonePe secret, no API route, and no extra NAT', () => {
  const { template, json } = synth();
  const statements = statementsFor(json, 'playx-dev-payment-reconcile');
  const secretsActions = statements
    .filter((st) => JSON.stringify(st.Action).includes('secretsmanager'))
    .map((st) => [st.Action].flat().sort().join(','));
  assert.deepEqual(secretsActions.sort(), [
    'secretsmanager:DescribeSecret,secretsmanager:GetSecretValue',
    'secretsmanager:GetSecretValue',
  ]);
  const nonSecrets = statements.filter((st) => !JSON.stringify(st.Action).includes('secretsmanager'));
  for (const st of nonSecrets) {
    // Only the CDK-default VPC/log ENI plumbing (managed-policy/log statements) — nothing app-specific.
    assert.ok(!JSON.stringify(st.Action).match(/s3|dynamodb|sqs|sns|ses|cognito|lambda:Invoke/i), JSON.stringify(st.Action));
  }
  const fn = lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === 'playx-dev-payment-reconcile')![1];
  assert.equal(fn.Properties.Environment.Variables.RECONCILE_BATCH_SIZE, '25');
  assert.ok(!('RECONCILE_MAX_AGE_MINUTES' in fn.Properties.Environment.Variables), 'no age cut-off for open attempts');
  assert.ok(!('PHONEPE_SANDBOX_TESTERS' in fn.Properties.Environment.Variables));
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  const routeKeys = Object.values<Json>(json.Resources).filter((r) => r.Type === 'AWS::ApiGatewayV2::Route').map((r) => r.Properties.RouteKey);
  assert.ok(!routeKeys.some((k) => /reconcile/i.test(k)));
});

// ---------------------------------------------------------------------------------------------
// PhonePe cutover Stage 2A: isolated PRODUCTION booking + payment-start runtime (start disabled).
// ---------------------------------------------------------------------------------------------

function lambdaNamed(json: Json, name: string): [string, Json] {
  const entry = lambdaEntries(json).find(([, r]) => r.Properties.FunctionName === name);
  assert.ok(entry, `Lambda ${name} exists`);
  return entry;
}

function envOf(json: Json, name: string): Json {
  return lambdaNamed(json, name)[1].Properties.Environment.Variables;
}

/** Every Secrets Manager resource ARN this Lambda's role may act on, as JSON text. */
function secretsResourcesFor(json: Json, name: string): string {
  return JSON.stringify(
    statementsFor(json, name)
      .filter((st) => JSON.stringify(st.Action).includes('secretsmanager'))
      .map((st) => st.Resource),
  );
}

/** The Lambda (logical id) an API route's integration invokes. */
function routeTarget(json: Json, routeKey: string): { route: Json; functionLogicalId: string } {
  const route = Object.values<Json>(json.Resources).find(
    (r) => r.Type === 'AWS::ApiGatewayV2::Route' && r.Properties.RouteKey === routeKey,
  );
  assert.ok(route, `route ${routeKey} exists`);
  const integrationId = (route.Properties.Target['Fn::Join'][1] as Json[]).find((part) => part.Ref)?.Ref as string;
  const integration = json.Resources[integrationId];
  assert.equal(integration.Type, 'AWS::ApiGatewayV2::Integration');
  const functionLogicalId = integration.Properties.IntegrationUri['Fn::GetAtt'][0] as string;
  return { route, functionLogicalId };
}

test('Stage 2A: sandbox PaymentStartFunction — sandbox secret/environment, start explicitly enabled, no production secret access', () => {
  const { json } = synth();
  const env = envOf(json, 'playx-dev-payment-start');
  assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox');
  assert.equal(env.PHONEPE_ENVIRONMENT, 'SANDBOX');
  assert.equal(env.PAYMENT_START_ENABLED, 'true', 'explicitly set, never a default');
  const secrets = secretsResourcesFor(json, 'playx-dev-payment-start');
  assert.ok(secrets.includes('secret:playx/phonepe/sandbox-??????'));
  assert.ok(!secrets.includes('playx/phonepe/production'), 'sandbox start cannot read the production secret');
  // The other sandbox payment Lambdas are equally blind to the production secret.
  for (const name of ['playx-dev-payment-status', 'playx-dev-payment-reconcile']) {
    assert.ok(!secretsResourcesFor(json, name).includes('playx/phonepe/production'), name);
    assert.equal(envOf(json, name).PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox', name);
  }
});

test('Stage 2A: PaymentStartProductionFunction — production secret/environment/return URL, start explicit (Stage 2D: on), production-only IAM', () => {
  const { json } = synth();
  const name = 'playx-dev-payment-start-production';
  const env = envOf(json, name);
  assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/production');
  assert.equal(env.PHONEPE_ENVIRONMENT, 'PRODUCTION');
  assert.equal(env.PAYMENT_START_ENABLED, 'true', 'Stage 2D: explicitly enabled (tester-gated in the backend)');
  assert.equal(env.PAYMENT_RETURN_URL, 'https://playxcafe.com/payment-return.html');
  assert.equal(env.PAYMENT_CHECKOUT_HOLD_MINUTES, '20');
  assert.ok(!('PHONEPE_SANDBOX_TESTERS' in env), 'no sandbox tester list on the production runtime');
  assert.ok(!JSON.stringify(env).includes('sandbox'), 'nothing sandbox-named in its configuration');

  // IAM: GetSecretValue on the production PhonePe secret ONLY (+ the usual DB-credentials read).
  const phonepe = statementsFor(json, name).filter(isPhonePeSecretStatement);
  assert.equal(phonepe.length, 1);
  assert.equal(phonepe[0].Effect, 'Allow');
  assert.equal(phonepe[0].Action, 'secretsmanager:GetSecretValue');
  const arn = JSON.stringify(phonepe[0].Resource);
  assert.ok(arn.includes('secret:playx/phonepe/production-??????'));
  assert.ok(!arn.includes('"*"') && !arn.includes('secret:*') && !arn.includes('playx/phonepe/*'));
  const secrets = secretsResourcesFor(json, name);
  assert.ok(!secrets.includes('playx/phonepe/sandbox'), 'no sandbox secret access');
  const secretsActions = statementsFor(json, name)
    .filter((st) => JSON.stringify(st.Action).includes('secretsmanager'))
    .map((st) => [st.Action].flat().sort().join(','))
    .sort();
  assert.deepEqual(secretsActions, ['secretsmanager:DescribeSecret,secretsmanager:GetSecretValue', 'secretsmanager:GetSecretValue']);
  // Stage 2B: + exactly sqs:SendMessage on the production fast-reconcile queue; nothing else.
  const sqsStatements = statementsFor(json, name).filter((x) => JSON.stringify(x.Action).includes('sqs'));
  assert.equal(sqsStatements.length, 1);
  assert.equal(sqsStatements[0].Action, 'sqs:SendMessage');
  for (const st of statementsFor(json, name).filter((x) => !JSON.stringify(x.Action).match(/secretsmanager|sqs/))) {
    assert.ok(!JSON.stringify(st.Action).match(/s3|dynamodb|sqs|sns|ses|cognito|lambda:Invoke/i), JSON.stringify(st.Action));
  }

  // Same network/runtime pattern as the sandbox payment-start Lambda.
  const prod = lambdaNamed(json, name)[1].Properties;
  const sandbox = lambdaNamed(json, 'playx-dev-payment-start')[1].Properties;
  assert.deepEqual(prod.VpcConfig, sandbox.VpcConfig, 'same private-with-egress subnets + shared Lambda SG');
  assert.equal(prod.Timeout, sandbox.Timeout);
  assert.equal(prod.MemorySize, sandbox.MemorySize);
  assert.equal(prod.Runtime, 'nodejs22.x');
  assert.equal(prod.Handler, sandbox.Handler);
});

test('Stage 2A: CreateBookingProductionFunction — DB access only, no PhonePe secret or configuration', () => {
  const { json } = synth();
  const name = 'playx-dev-create-booking-production';
  const [, fn] = lambdaNamed(json, name);
  assert.equal(statementsFor(json, name).filter(isPhonePeSecretStatement).length, 0);
  assert.ok(!secretsResourcesFor(json, name).includes('phonepe'));
  // Stage 2C: + the production tester allowlist (not PhonePe configuration); nothing else.
  assert.deepEqual(Object.keys(fn.Properties.Environment.Variables).sort(), ['BOOKING_CREATE_ENABLED', 'DB_SECRET_ARN', 'PHONEPE_PRODUCTION_TESTERS']);
  const { PHONEPE_PRODUCTION_TESTERS: _testers, ...rest } = fn.Properties.Environment.Variables;
  assert.ok(!JSON.stringify(rest).match(/PHONEPE|PAYMENT_/));
  // Same isolated placement as the sandbox create-booking Lambda.
  assert.deepEqual(fn.Properties.VpcConfig, lambdaNamed(json, 'playx-dev-create-booking')[1].Properties.VpcConfig);
});

test('Stage 2A: routes — sandbox and production booking/payment-start routes hit their own Lambdas, all JWT-protected', () => {
  const { json } = synth();
  const authorizerId = Object.entries<Json>(json.Resources).find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Authorizer')?.[0];
  const expected: [string, string][] = [
    ['POST /bookings', 'playx-dev-create-booking'],
    ['POST /bookings/production', 'playx-dev-create-booking-production'],
    ['POST /payments/start', 'playx-dev-payment-start'],
    ['POST /payments/production/start', 'playx-dev-payment-start-production'],
  ];
  for (const [routeKey, functionName] of expected) {
    const { route, functionLogicalId } = routeTarget(json, routeKey);
    assert.equal(route.Properties.AuthorizationType, 'JWT', `${routeKey} requires a Cognito JWT`);
    assert.deepEqual(route.Properties.AuthorizerId, { Ref: authorizerId }, `${routeKey}: the one Cognito authorizer`);
    assert.equal(json.Resources[functionLogicalId].Properties.FunctionName, functionName, `${routeKey} -> ${functionName}`);
  }
  // Entry points: sandbox booking stays create-booking.ts; production uses the thin PRODUCTION
  // wrapper; both payment-start Lambdas run the same payment-start.ts business logic.
  // (Compared by bundled-code asset hash: same entry + bundling => same asset.)
  const code = (name: string) => JSON.stringify(lambdaNamed(json, name)[1].Properties.Code.S3Key);
  assert.notEqual(code('playx-dev-create-booking'), code('playx-dev-create-booking-production'));
  assert.equal(code('playx-dev-payment-start'), code('playx-dev-payment-start-production'));

  const routeKeys = Object.values<Json>(json.Resources)
    .filter((r) => r.Type === 'AWS::ApiGatewayV2::Route')
    .map((r) => r.Properties as Json);
  // Every production route is JWT-protected EXCEPT Stage 2C's PhonePe webhook (PhonePe holds no
  // token; the Lambda authenticates each callback itself — see the Stage 2C tests below).
  for (const r of routeKeys.filter((x) => /production/.test(x.RouteKey) && x.RouteKey !== 'POST /payments/production/webhook')) {
    assert.equal(r.AuthorizationType, 'JWT', `${r.RouteKey} is never public`);
  }
  assert.deepEqual(
    routeKeys.map((r) => r.RouteKey as string).filter((k) => /production/.test(k)).sort(),
    [
      'GET /payments/production/{bookingId}/status',
      'POST /bookings/production',
      'POST /payments/production/start',
      'POST /payments/production/webhook',
    ],
  );
});

test('Stage 2A/2B: shared infrastructure only — no second VPC/RDS/Cognito/NAT/API; only Stage 2B\'s two queues and one extra schedule; no new secret', () => {
  const { template, json } = synth();
  template.resourceCountIs('AWS::EC2::VPC', 1);
  template.resourceCountIs('AWS::RDS::DBInstance', 1);
  template.resourceCountIs('AWS::Cognito::UserPool', 1);
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  template.resourceCountIs('AWS::SQS::Queue', 2);
  template.resourceCountIs('AWS::Events::Rule', 2);
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  // The two EventBridge targets are exactly the sandbox and production 5-minute reconcilers.
  const targets = Object.values<Json>(json.Resources)
    .filter((r) => r.Type === 'AWS::Events::Rule')
    .flatMap((r) => r.Properties.Targets.map((t: Json) => json.Resources[t.Arn['Fn::GetAtt'][0]].Properties.FunctionName))
    .sort();
  assert.deepEqual(targets, ['playx-dev-payment-reconcile', 'playx-dev-payment-reconcile-production']);
  // + Stage 2C's production payment-status and webhook Lambdas.
  const names = lambdaEntries(json).map(([, r]) => r.Properties.FunctionName as string);
  assert.deepEqual(names.filter((n) => /production/.test(n)).sort(), [
    'playx-dev-create-booking-production',
    'playx-dev-payment-reconcile-production',
    'playx-dev-payment-reconcile-production-fast',
    'playx-dev-payment-start-production',
    'playx-dev-payment-status-production',
    'playx-dev-payment-webhook-production',
  ]);
});

test('Stage 2A: booking-creation kill switch — set explicitly on both create-booking Lambdas (Stage 2D: both on)', () => {
  const { json } = synth();
  assert.equal(envOf(json, 'playx-dev-create-booking').BOOKING_CREATE_ENABLED, 'true');
  assert.equal(envOf(json, 'playx-dev-create-booking-production').BOOKING_CREATE_ENABLED, 'true');
  assert.equal(envOf(json, 'playx-dev-payment-start').PAYMENT_START_ENABLED, 'true');
  assert.equal(envOf(json, 'playx-dev-payment-start-production').PAYMENT_START_ENABLED, 'true');
  // The switch is only on the two create-booking Lambdas.
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    if (name === 'playx-dev-create-booking' || name === 'playx-dev-create-booking-production') continue;
    assert.ok(!JSON.stringify(fn.Properties.Environment ?? {}).includes('BOOKING_CREATE_ENABLED'), name);
  }
});

// ---------------------------------------------------------------------------------------------
// PhonePe cutover Stage 2B: PRODUCTION fast payment reconciliation (SQS + worker + fallback).
// ---------------------------------------------------------------------------------------------

function queueNamed(json: Json, name: string): [string, Json] {
  const entry = Object.entries<Json>(json.Resources).find(([, r]) => r.Type === 'AWS::SQS::Queue' && r.Properties.QueueName === name);
  assert.ok(entry, `queue ${name} exists`);
  return entry;
}

/** Every SQS action this Lambda's role may perform, sorted, with the queue logical id(s) they target. */
function sqsGrantsFor(json: Json, name: string): { actions: string[]; resources: string[] } {
  const statements = statementsFor(json, name).filter((st) => JSON.stringify(st.Action).includes('sqs:'));
  return {
    actions: statements.flatMap((st) => [st.Action].flat() as string[]).sort(),
    resources: [...new Set(statements.map((st) => JSON.stringify(st.Resource)))],
  };
}

test('Stage 2B: standard fast queue + DLQ — redrive after 5 receives, visibility > worker timeout, DLQ outlives the source', () => {
  const { json } = synth();
  const [fastId, fast] = queueNamed(json, 'playx-dev-payment-reconcile-production-fast');
  const [dlqId, dlq] = queueNamed(json, 'playx-dev-payment-reconcile-production-dlq');
  assert.equal(fast.Properties.FifoQueue, undefined, 'standard queue, not FIFO');
  assert.equal(dlq.Properties.FifoQueue, undefined);
  assert.deepEqual(fast.Properties.RedrivePolicy, { deadLetterTargetArn: { 'Fn::GetAtt': [dlqId, 'Arn'] }, maxReceiveCount: 5 });
  const worker = lambdaNamed(json, 'playx-dev-payment-reconcile-production-fast')[1];
  assert.equal(worker.Properties.Timeout, 25);
  assert.ok(fast.Properties.VisibilityTimeout >= 6 * worker.Properties.Timeout, 'visibility timeout safely above the Lambda timeout');
  assert.equal(fast.Properties.MessageRetentionPeriod, 86400);
  assert.equal(dlq.Properties.MessageRetentionPeriod, 1209600);
  assert.ok(dlq.Properties.MessageRetentionPeriod > fast.Properties.MessageRetentionPeriod);
  for (const q of [fast, dlq]) {
    assert.equal(q.Properties.SqsManagedSseEnabled, true, 'encrypted at rest');
  }
  // TLS-only queue policies on both.
  for (const id of [fastId, dlqId]) {
    const policy = Object.values<Json>(json.Resources).find(
      (r) => r.Type === 'AWS::SQS::QueuePolicy' && r.Properties.Queues.some((q: Json) => q.Ref === id),
    );
    assert.ok(policy, `${id} has a queue policy`);
    assert.equal(policy.Properties.PolicyDocument.Statement[0].Effect, 'Deny');
    assert.deepEqual(policy.Properties.PolicyDocument.Statement[0].Condition, { Bool: { 'aws:SecureTransport': 'false' } });
  }
});

test('Stage 2B: the fast worker consumes ONLY the production fast queue, batch size 1', () => {
  const { json } = synth();
  const [fastId] = queueNamed(json, 'playx-dev-payment-reconcile-production-fast');
  const [workerId] = lambdaNamed(json, 'playx-dev-payment-reconcile-production-fast');
  const mappings = Object.values<Json>(json.Resources).filter((r) => r.Type === 'AWS::Lambda::EventSourceMapping');
  assert.equal(mappings.length, 1, 'the only event source mapping in the stack');
  assert.equal(mappings[0].Properties.BatchSize, 1);
  assert.deepEqual(mappings[0].Properties.EventSourceArn, { 'Fn::GetAtt': [fastId, 'Arn'] });
  assert.deepEqual(mappings[0].Properties.FunctionName, { Ref: workerId });
  assert.equal(mappings[0].Properties.Enabled, undefined, 'enabled (default) — idle until something enqueues');
});

test('Stage 2B: the fast worker has NO reserved concurrency (no SQS-delivery throttling) and no event-source max-concurrency', () => {
  const { json } = synth();
  const [, worker] = lambdaNamed(json, 'playx-dev-payment-reconcile-production-fast');
  assert.equal(worker.Properties.ReservedConcurrentExecutions, undefined);
  const mapping = Object.values<Json>(json.Resources).find((r) => r.Type === 'AWS::Lambda::EventSourceMapping')!;
  assert.equal(mapping.Properties.BatchSize, 1);
  assert.equal(mapping.Properties.ScalingConfig, undefined, 'no event-source max-concurrency override');
});

test('Stage 2B: fast worker — production secret ONLY, consume + SendMessage on its own queue only, same network as payment Lambdas', () => {
  const { json } = synth();
  const name = 'playx-dev-payment-reconcile-production-fast';
  const [fastId] = queueNamed(json, 'playx-dev-payment-reconcile-production-fast');
  const env = envOf(json, name);
  assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/production');
  assert.equal(env.PHONEPE_ENVIRONMENT, 'PRODUCTION');
  assert.deepEqual(env.PAYMENT_RECONCILE_QUEUE_URL, { Ref: fastId });
  assert.ok(!JSON.stringify(env).includes('sandbox'));
  assert.ok(!('PAYMENT_START_ENABLED' in env) && !('PHONEPE_SANDBOX_TESTERS' in env));

  const secrets = secretsResourcesFor(json, name);
  assert.ok(secrets.includes('secret:playx/phonepe/production-??????'));
  assert.ok(!secrets.includes('playx/phonepe/sandbox'), 'NO sandbox secret');
  assert.ok(!secrets.includes('playx/phonepe/*'));

  const grants = sqsGrantsFor(json, name);
  assert.deepEqual(grants.actions, [
    'sqs:ChangeMessageVisibility',
    'sqs:DeleteMessage',
    'sqs:GetQueueAttributes',
    'sqs:GetQueueUrl',
    'sqs:ReceiveMessage',
    'sqs:SendMessage',
  ]);
  assert.deepEqual(grants.resources, [JSON.stringify({ 'Fn::GetAtt': [fastId, 'Arn'] })], 'only the production fast queue — never the DLQ, never *');
  for (const st of statementsFor(json, name).filter((x) => !JSON.stringify(x.Action).match(/secretsmanager|sqs:/))) {
    assert.ok(!JSON.stringify(st.Action).match(/s3|dynamodb|sns|ses|cognito|lambda:Invoke/i), JSON.stringify(st.Action));
  }
  const fn = lambdaNamed(json, name)[1].Properties;
  assert.deepEqual(fn.VpcConfig, lambdaNamed(json, 'playx-dev-payment-start')[1].Properties.VpcConfig, 'private-with-egress + shared Lambda SG');
});

test('Stage 2B: production payment-start gets the queue URL and ONLY sqs:SendMessage on the production fast queue', () => {
  const { json } = synth();
  const [fastId] = queueNamed(json, 'playx-dev-payment-reconcile-production-fast');
  const env = envOf(json, 'playx-dev-payment-start-production');
  assert.deepEqual(env.PAYMENT_RECONCILE_QUEUE_URL, { Ref: fastId });
  assert.deepEqual(sqsGrantsFor(json, 'playx-dev-payment-start-production'), {
    actions: ['sqs:SendMessage'],
    resources: [JSON.stringify({ 'Fn::GetAtt': [fastId, 'Arn'] })],
  });
});

test('Stage 2B: sandbox payment Lambdas and every non-payment Lambda have NO SQS access and no queue URL', () => {
  const { json } = synth();
  const queueUsers = [
    'playx-dev-payment-start-production',
    'playx-dev-payment-reconcile-production-fast',
  ];
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    if (queueUsers.includes(name)) continue;
    assert.deepEqual(sqsGrantsFor(json, name).actions, [], `${name} has no SQS permission`);
    assert.ok(!JSON.stringify(fn.Properties.Environment ?? {}).includes('PAYMENT_RECONCILE_QUEUE_URL'), name);
  }
  for (const name of ['playx-dev-payment-start', 'playx-dev-payment-status', 'playx-dev-payment-reconcile']) {
    assert.ok(!secretsResourcesFor(json, name).includes('playx/phonepe/production'), `${name} stays sandbox-only`);
  }
});

test('Stage 2B: production 5-minute fallback — own rule rate(5 minutes), production secret only, no SQS', () => {
  const { json } = synth();
  const name = 'playx-dev-payment-reconcile-production';
  const [fnId, fn] = lambdaNamed(json, name);
  const env = fn.Properties.Environment.Variables;
  assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/production');
  assert.equal(env.PHONEPE_ENVIRONMENT, 'PRODUCTION');
  assert.equal(env.RECONCILE_BATCH_SIZE, '25');
  assert.ok(!('PAYMENT_RECONCILE_QUEUE_URL' in env));
  assert.equal(fn.Properties.Timeout, 240);

  const secrets = secretsResourcesFor(json, name);
  assert.ok(secrets.includes('secret:playx/phonepe/production-??????'));
  assert.ok(!secrets.includes('playx/phonepe/sandbox'));
  assert.deepEqual(sqsGrantsFor(json, name).actions, []);

  const [ruleId, rule] = Object.entries<Json>(json.Resources).find(
    ([, r]) => r.Type === 'AWS::Events::Rule' && r.Properties.Targets.some((t: Json) => t.Arn['Fn::GetAtt']?.[0] === fnId),
  )!;
  assert.equal(rule.Properties.ScheduleExpression, 'rate(5 minutes)');
  assert.equal(rule.Properties.State, 'ENABLED');
  assert.equal(rule.Properties.Targets.length, 1);
  assert.equal(rule.Properties.Targets[0].RetryPolicy.MaximumRetryAttempts, 0);
  assert.equal(rule.Properties.Targets[0].Input, undefined, 'no event payload is passed (it could not choose the environment anyway)');
  const permissions = Object.values<Json>(json.Resources).filter(
    (r) => r.Type === 'AWS::Lambda::Permission' && JSON.stringify(r.Properties.FunctionName).includes(fnId),
  );
  assert.equal(permissions.length, 1);
  assert.deepEqual(permissions[0].Properties.SourceArn, { 'Fn::GetAtt': [ruleId, 'Arn'] });
});

test('Stage 2B: the existing sandbox reconciler and its rule are unchanged', () => {
  const { json } = synth();
  const [fnId, fn] = lambdaNamed(json, 'playx-dev-payment-reconcile');
  assert.ok(fnId.startsWith('ApiPaymentReconcileFunction'), 'same logical id');
  assert.equal(fn.Properties.Environment.Variables.PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox');
  assert.equal(fn.Properties.Environment.Variables.PHONEPE_ENVIRONMENT, 'SANDBOX');
  assert.equal(fn.Properties.Timeout, 240);
  const rules = Object.entries<Json>(json.Resources).filter(
    ([, r]) => r.Type === 'AWS::Events::Rule' && r.Properties.Targets.some((t: Json) => t.Arn['Fn::GetAtt']?.[0] === fnId),
  );
  assert.equal(rules.length, 1);
  assert.ok(rules[0][0].startsWith('ApiPaymentReconcileSchedule'));
  assert.equal(rules[0][1].Properties.ScheduleExpression, 'rate(5 minutes)');
  // Different entry file from the production fallback (each hard-codes its own environment).
  assert.notEqual(
    JSON.stringify(fn.Properties.Code.S3Key),
    JSON.stringify(lambdaNamed(json, 'playx-dev-payment-reconcile-production')[1].Properties.Code.S3Key),
  );
});

test('Stage 2B: DLQ alarm fires on ApproximateNumberOfMessagesVisible > 0 for the production DLQ', () => {
  const { template, json } = synth();
  template.resourceCountIs('AWS::CloudWatch::Alarm', 1);
  const alarm = Object.values<Json>(json.Resources).find((r) => r.Type === 'AWS::CloudWatch::Alarm')!.Properties;
  const [dlqId] = queueNamed(json, 'playx-dev-payment-reconcile-production-dlq');
  assert.equal(alarm.AlarmName, 'playx-dev-payment-reconcile-production-dlq-messages');
  assert.equal(alarm.Namespace, 'AWS/SQS');
  assert.equal(alarm.MetricName, 'ApproximateNumberOfMessagesVisible');
  assert.deepEqual(alarm.Dimensions, [{ Name: 'QueueName', Value: { 'Fn::GetAtt': [dlqId, 'QueueName'] } }]);
  assert.equal(alarm.ComparisonOperator, 'GreaterThanThreshold');
  assert.equal(alarm.Threshold, 0);
  assert.equal(alarm.EvaluationPeriods, 1);
  assert.equal(alarm.Statistic, 'Maximum');
  assert.equal(alarm.Period, 60);
  assert.equal(alarm.TreatMissingData, 'notBreaching');
  // No SNS/email integration added in this stage.
  template.resourceCountIs('AWS::SNS::Topic', 0);
  assert.equal(alarm.AlarmActions, undefined);
});

test('Stage 2B: no reconcile route', () => {
  const { json } = synth();
  const routeKeys = Object.values<Json>(json.Resources)
    .filter((r) => r.Type === 'AWS::ApiGatewayV2::Route')
    .map((r) => r.Properties.RouteKey as string);
  assert.ok(routeKeys.every((k) => !/callback|reconcile/i.test(k)));
});

// ---------------------------------------------------------------------------------------------
// PhonePe cutover Stage 2C: public PRODUCTION webhook, PRODUCTION status route, tester allowlist.
// ---------------------------------------------------------------------------------------------

const TESTER_A = '0d7c2a4e-1111-4a2b-9c3d-4e5f6a7b8c9d';
const TESTER_B = 'a1b2c3d4-2222-4e5f-8a9b-0c1d2e3f4a5b';

/** Secrets Manager actions this Lambda's role holds, one sorted "a,b" string per statement. */
function secretsActionsFor(json: Json, name: string): string[] {
  return statementsFor(json, name)
    .filter((st) => JSON.stringify(st.Action).includes('secretsmanager'))
    .map((st) => [st.Action].flat().sort().join(','))
    .sort();
}

test('Stage 2C: POST /payments/production/webhook is PUBLIC (no authorizer) and invokes only the webhook Lambda', () => {
  const { json } = synth();
  const { route, functionLogicalId } = routeTarget(json, 'POST /payments/production/webhook');
  assert.equal(route.Properties.AuthorizationType, 'NONE', 'PhonePe holds no Cognito token');
  assert.equal(route.Properties.AuthorizerId, undefined);
  assert.equal(json.Resources[functionLogicalId].Properties.FunctionName, 'playx-dev-payment-webhook-production');
  // POST only: no other method on the webhook path.
  const webhookRoutes = Object.values<Json>(json.Resources).filter(
    (r) => r.Type === 'AWS::ApiGatewayV2::Route' && /webhook/.test(r.Properties.RouteKey),
  );
  assert.equal(webhookRoutes.length, 1);
  // It is the ONLY public payment route.
  for (const r of Object.values<Json>(json.Resources).filter((x) => x.Type === 'AWS::ApiGatewayV2::Route')) {
    if (/\/payments/.test(r.Properties.RouteKey) && r.Properties.RouteKey !== 'POST /payments/production/webhook') {
      assert.equal(r.Properties.AuthorizationType, 'JWT', r.Properties.RouteKey);
    }
  }
});

test('Stage 2C: GET /payments/production/{bookingId}/status uses the Cognito JWT authorizer and its own production Lambda', () => {
  const { json } = synth();
  const authorizerId = Object.entries<Json>(json.Resources).find(([, r]) => r.Type === 'AWS::ApiGatewayV2::Authorizer')?.[0];
  const { route, functionLogicalId } = routeTarget(json, 'GET /payments/production/{bookingId}/status');
  assert.equal(route.Properties.AuthorizationType, 'JWT');
  assert.deepEqual(route.Properties.AuthorizerId, { Ref: authorizerId });
  assert.equal(json.Resources[functionLogicalId].Properties.FunctionName, 'playx-dev-payment-status-production');
  // The sandbox status route is untouched and still hits the sandbox Lambda.
  const sandbox = routeTarget(json, 'GET /payments/{bookingId}/status');
  assert.equal(sandbox.route.Properties.AuthorizationType, 'JWT');
  assert.equal(json.Resources[sandbox.functionLogicalId].Properties.FunctionName, 'playx-dev-payment-status');
  assert.ok(sandbox.functionLogicalId.startsWith('ApiPaymentStatusFunction'), 'same logical id as before');
  // Different entry file from the sandbox status Lambda (the production one hard-codes PRODUCTION).
  assert.notEqual(
    JSON.stringify(lambdaNamed(json, 'playx-dev-payment-status')[1].Properties.Code.S3Key),
    JSON.stringify(lambdaNamed(json, 'playx-dev-payment-status-production')[1].Properties.Code.S3Key),
  );
});

for (const name of ['playx-dev-payment-webhook-production', 'playx-dev-payment-status-production']) {
  test(`Stage 2C: ${name} — production secret ONLY (+ DB secret read), no SQS, no credentials or switches in its environment`, () => {
    const { json } = synth();
    const env = envOf(json, name);
    assert.deepEqual(Object.keys(env).sort(), ['DB_SECRET_ARN', 'PHONEPE_ENVIRONMENT', 'PHONEPE_SECRET_NAME']);
    assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/production');
    assert.equal(env.PHONEPE_ENVIRONMENT, 'PRODUCTION');
    assert.ok(!/sandbox|webhook_?(user|pass)|password|username/i.test(JSON.stringify(env)), 'no sandbox reference, no webhook credential');

    const phonepe = statementsFor(json, name).filter(isPhonePeSecretStatement);
    assert.equal(phonepe.length, 1);
    assert.equal(phonepe[0].Effect, 'Allow');
    assert.equal(phonepe[0].Action, 'secretsmanager:GetSecretValue');
    const arn = JSON.stringify(phonepe[0].Resource);
    assert.ok(arn.includes('secret:playx/phonepe/production-??????'));
    assert.ok(!arn.includes('"*"') && !arn.includes('secret:*') && !arn.includes('playx/phonepe/*'));
    assert.ok(!secretsResourcesFor(json, name).includes('playx/phonepe/sandbox'), 'NO sandbox secret grant');
    assert.deepEqual(secretsActionsFor(json, name), ['secretsmanager:DescribeSecret,secretsmanager:GetSecretValue', 'secretsmanager:GetSecretValue']);
    assert.deepEqual(sqsGrantsFor(json, name).actions, [], 'no SQS permission');
    for (const st of statementsFor(json, name).filter((x) => !JSON.stringify(x.Action).includes('secretsmanager'))) {
      assert.ok(!JSON.stringify(st.Action).match(/s3|dynamodb|sqs|sns|ses|cognito|lambda:Invoke/i), JSON.stringify(st.Action));
    }

    // Same network/runtime pattern as the other payment Lambdas (private-with-egress + shared SG).
    const fn = lambdaNamed(json, name)[1].Properties;
    const sandboxStart = lambdaNamed(json, 'playx-dev-payment-start')[1].Properties;
    assert.deepEqual(fn.VpcConfig, sandboxStart.VpcConfig);
    assert.equal(fn.Timeout, 25);
    assert.equal(fn.Runtime, 'nodejs22.x');
  });
}

test('Stage 2C: the sandbox payment Lambdas are unchanged — sandbox secret only, no production testers, no production secret', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  for (const name of ['playx-dev-payment-start', 'playx-dev-payment-status', 'playx-dev-payment-reconcile']) {
    const secrets = secretsResourcesFor(json, name);
    assert.ok(secrets.includes('secret:playx/phonepe/sandbox-??????'), name);
    assert.ok(!secrets.includes('playx/phonepe/production'), name);
    assert.ok(!('PHONEPE_PRODUCTION_TESTERS' in envOf(json, name)), name);
  }
  assert.equal(envOf(json, 'playx-dev-payment-status').PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox');
});

test('Stage 2C: phonepeProductionTesters context reaches ONLY the production booking + payment-start Lambdas, trimmed and de-duplicated', () => {
  const { json } = synth({ phonepeProductionTesters: ` ${TESTER_A} ,, ${TESTER_B},${TESTER_A} ` });
  const holders: string[] = [];
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    const env = fn.Properties.Environment?.Variables ?? {};
    if ('PHONEPE_PRODUCTION_TESTERS' in env) {
      holders.push(name);
      assert.equal(env.PHONEPE_PRODUCTION_TESTERS, `${TESTER_A},${TESTER_B}`, name);
    }
    assert.ok(!JSON.stringify(env).includes(TESTER_A) || 'PHONEPE_PRODUCTION_TESTERS' in env, `${name} must not see the list`);
  }
  assert.deepEqual(holders.sort(), ['playx-dev-create-booking-production', 'playx-dev-payment-start-production']);
});

test('Stage 2C: no production tester context -> the list synthesizes EMPTY (backend denies everyone)', () => {
  const saved = process.env.PHONEPE_PRODUCTION_TESTERS;
  delete process.env.PHONEPE_PRODUCTION_TESTERS;
  try {
    for (const context of [undefined, { phonepeProductionTesters: '' }, { phonepeProductionTesters: '  ' }]) {
      const { json } = synth(context);
      assert.equal(envOf(json, 'playx-dev-create-booking-production').PHONEPE_PRODUCTION_TESTERS, '');
      assert.equal(envOf(json, 'playx-dev-payment-start-production').PHONEPE_PRODUCTION_TESTERS, '');
    }
  } finally {
    if (saved !== undefined) process.env.PHONEPE_PRODUCTION_TESTERS = saved;
  }
});

test('Stage 2C: production testers must be Cognito subs — an email or other value fails the synth (never silently trusted)', () => {
  for (const bad of ['tester@example.com', `${TESTER_A},tester@example.com`, TESTER_A.toUpperCase(), 'not-a-sub', `${TESTER_A}x`]) {
    assert.throws(() => synth({ phonepeProductionTesters: bad }), /Cognito subs/, bad);
  }
});

test('Stage 2C: production kill switches are independent of the tester list (Stage 2D: on either way)', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  assert.equal(envOf(json, 'playx-dev-create-booking-production').BOOKING_CREATE_ENABLED, 'true');
  assert.equal(envOf(json, 'playx-dev-payment-start-production').PAYMENT_START_ENABLED, 'true');
  // Sandbox switches unchanged.
  assert.equal(envOf(json, 'playx-dev-create-booking').BOOKING_CREATE_ENABLED, 'true');
  assert.equal(envOf(json, 'playx-dev-payment-start').PAYMENT_START_ENABLED, 'true');
  // The new Lambdas carry no switch of their own (nothing to enable).
  for (const name of ['playx-dev-payment-webhook-production', 'playx-dev-payment-status-production']) {
    const env = envOf(json, name);
    assert.ok(!('PAYMENT_START_ENABLED' in env) && !('BOOKING_CREATE_ENABLED' in env), name);
  }
});

test('Stage 2C: shared infrastructure only — no new queue, rule, secret, authorizer, API or NAT', () => {
  const { template } = synth();
  template.resourceCountIs('AWS::SQS::Queue', 2);
  template.resourceCountIs('AWS::Events::Rule', 2);
  template.resourceCountIs('AWS::SecretsManager::Secret', 1);
  template.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.resourceCountIs('AWS::EC2::NatGateway', 1);
  template.resourceCountIs('AWS::Lambda::EventSourceMapping', 1);
});

// ---------------------------------------------------------------------------------------------
// PhonePe cutover Stage 2D: both production kill switches ON for one controlled production
// transaction; the production tester allowlist stays the second, mandatory gate.
// ---------------------------------------------------------------------------------------------

const PRODUCTION_SECRET_HOLDERS = [
  'playx-dev-payment-reconcile-production',
  'playx-dev-payment-reconcile-production-fast',
  'playx-dev-payment-start-production',
  'playx-dev-payment-status-production',
  'playx-dev-payment-webhook-production',
];

test('Stage 2D: BOOKING_CREATE_ENABLED=true only on the two create-booking Lambdas; PAYMENT_START_ENABLED=true only on the two payment-start Lambdas', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  const bookingSwitch: Record<string, string> = {};
  const paymentSwitch: Record<string, string> = {};
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    const env = fn.Properties.Environment?.Variables ?? {};
    if ('BOOKING_CREATE_ENABLED' in env) bookingSwitch[name] = env.BOOKING_CREATE_ENABLED;
    if ('PAYMENT_START_ENABLED' in env) paymentSwitch[name] = env.PAYMENT_START_ENABLED;
  }
  assert.deepEqual(bookingSwitch, { 'playx-dev-create-booking': 'true', 'playx-dev-create-booking-production': 'true' });
  assert.deepEqual(paymentSwitch, { 'playx-dev-payment-start': 'true', 'playx-dev-payment-start-production': 'true' });
  // The production switches ride on the production entry files / production PhonePe config only.
  assert.equal(envOf(json, 'playx-dev-payment-start-production').PHONEPE_ENVIRONMENT, 'PRODUCTION');
  assert.equal(envOf(json, 'playx-dev-payment-start-production').PHONEPE_SECRET_NAME, 'playx/phonepe/production');
});

test('Stage 2D: PHONEPE_PRODUCTION_TESTERS still reaches both enabled production Lambdas (and nothing else)', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  for (const name of ['playx-dev-create-booking-production', 'playx-dev-payment-start-production']) {
    assert.equal(envOf(json, name).PHONEPE_PRODUCTION_TESTERS, TESTER_A, name);
  }
  const holders = lambdaEntries(json)
    .filter(([, fn]) => 'PHONEPE_PRODUCTION_TESTERS' in (fn.Properties.Environment?.Variables ?? {}))
    .map(([, fn]) => fn.Properties.FunctionName as string)
    .sort();
  assert.deepEqual(holders, ['playx-dev-create-booking-production', 'playx-dev-payment-start-production']);
});

test('Stage 2D: switches on + no tester context still synthesizes an EMPTY allowlist (backend 403s everyone)', () => {
  const saved = process.env.PHONEPE_PRODUCTION_TESTERS;
  delete process.env.PHONEPE_PRODUCTION_TESTERS;
  try {
    const { json } = synth();
    assert.equal(envOf(json, 'playx-dev-create-booking-production').BOOKING_CREATE_ENABLED, 'true');
    assert.equal(envOf(json, 'playx-dev-create-booking-production').PHONEPE_PRODUCTION_TESTERS, '');
    assert.equal(envOf(json, 'playx-dev-payment-start-production').PAYMENT_START_ENABLED, 'true');
    assert.equal(envOf(json, 'playx-dev-payment-start-production').PHONEPE_PRODUCTION_TESTERS, '');
  } finally {
    if (saved !== undefined) process.env.PHONEPE_PRODUCTION_TESTERS = saved;
  }
});

test('Stage 2D: production webhook and production status route/Lambdas are unchanged (no switch, no testers, public/JWT as before)', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  const webhook = routeTarget(json, 'POST /payments/production/webhook');
  assert.equal(webhook.route.Properties.AuthorizationType, 'NONE');
  assert.equal(json.Resources[webhook.functionLogicalId].Properties.FunctionName, 'playx-dev-payment-webhook-production');
  const status = routeTarget(json, 'GET /payments/production/{bookingId}/status');
  assert.equal(status.route.Properties.AuthorizationType, 'JWT');
  assert.equal(json.Resources[status.functionLogicalId].Properties.FunctionName, 'playx-dev-payment-status-production');
  for (const name of ['playx-dev-payment-webhook-production', 'playx-dev-payment-status-production']) {
    assert.deepEqual(Object.keys(envOf(json, name)).sort(), ['DB_SECRET_ARN', 'PHONEPE_ENVIRONMENT', 'PHONEPE_SECRET_NAME'], name);
    assert.equal(envOf(json, name).PHONEPE_ENVIRONMENT, 'PRODUCTION', name);
  }
});

test('Stage 2D: sandbox functions remain SANDBOX, with the sandbox secret only', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  for (const name of ['playx-dev-payment-start', 'playx-dev-payment-status', 'playx-dev-payment-reconcile']) {
    const env = envOf(json, name);
    assert.equal(env.PHONEPE_ENVIRONMENT, 'SANDBOX', name);
    assert.equal(env.PHONEPE_SECRET_NAME, 'playx/phonepe/sandbox', name);
    const secrets = secretsResourcesFor(json, name);
    assert.ok(secrets.includes('secret:playx/phonepe/sandbox-??????') && !secrets.includes('playx/phonepe/production'), name);
  }
  assert.equal(envOf(json, 'playx-dev-payment-start').PAYMENT_RETURN_URL, 'https://staging.playxcafe.com/payment-return.html');
  // The sandbox create-booking Lambda has no PhonePe configuration and no production tester list.
  assert.deepEqual(Object.keys(envOf(json, 'playx-dev-create-booking')).sort(), ['BOOKING_CREATE_ENABLED', 'DB_SECRET_ARN']);
});

test('Stage 2D: no sandbox secret grant to any production Lambda; no production secret grant to any unrelated Lambda', () => {
  const { json } = synth({ phonepeProductionTesters: TESTER_A });
  const productionHolders: string[] = [];
  for (const [, fn] of lambdaEntries(json)) {
    const name = fn.Properties.FunctionName as string;
    const secrets = secretsResourcesFor(json, name);
    if (secrets.includes('playx/phonepe/production')) productionHolders.push(name);
    if (/production/.test(name)) {
      assert.ok(!secrets.includes('playx/phonepe/sandbox'), `${name} must not read the sandbox secret`);
    }
  }
  assert.deepEqual(productionHolders.sort(), PRODUCTION_SECRET_HOLDERS);
  // The production create-booking Lambda gets no PhonePe secret at all.
  assert.ok(!secretsResourcesFor(json, 'playx-dev-create-booking-production').includes('phonepe'));
});
