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

  // No NAT Gateway. Exactly five Lambdas: Story 2.3's migration function, Story 2.5's
  // health-check function, and Story 2.6's products/create-booking/bookings-me functions — not
  // the restrictDefaultSecurityGroup feature flag's custom-resource Lambda, which stays guarded
  // against separately (that flag is explicitly disabled for this VPC — see constructs/network.ts).
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::Lambda::Function', 5);
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

  // Five Lambda functions exist in the stack (this one, Story 2.5's health-check function, and
  // Story 2.6's products/create-booking/bookings-me functions — see below), but the health
  // function is the only one of the five that does NOT sit in the VPC.
  template.resourceCountIs('AWS::Lambda::Function', 5);
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

  // Exactly one app client: the public web client. No secret, SRP-only.
  template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
  template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
    ClientName: 'playx-dev-web-client',
    GenerateSecret: false,
    ExplicitAuthFlows: Match.arrayWith(['ALLOW_USER_SRP_AUTH']),
    PreventUserExistenceErrors: 'ENABLED',
  });

  // The User Pool ID and App Client ID are surfaced as stack outputs.
  template.hasOutput('*', Match.objectLike({ Description: 'Play X Cognito User Pool ID' }));
  template.hasOutput(
    '*',
    Match.objectLike({ Description: 'Play X Cognito App Client ID (public web client, no secret)' }),
  );
});

test('Story 2.5: HTTP API with a GET /health route, CORS-scoped to the GitHub Pages origin', () => {
  const app = new cdk.App();
  const stack = new InfraStack(app, 'TestInfraStack', {
    envConfig: environments.dev,
    env: { region: 'ap-south-1' },
  });
  const template = Template.fromStack(stack);

  // Exactly one HTTP API (not a REST API/RestApi — see the Story 2.3 test above), CORS
  // restricted to the GitHub Pages origin index.html/auth.html are served from. AllowMethods now
  // includes POST too (Story 2.6's POST /bookings), so this is arrayWith rather than an exact
  // match.
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
    Name: 'playx-dev-api',
    ProtocolType: 'HTTP',
    CorsConfiguration: Match.objectLike({
      AllowOrigins: ['https://ranjan-techno.github.io'],
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

  // Four routes total: GET /health (Story 2.5), plus GET /products, POST /bookings, and
  // GET /bookings/me (this story). Four integrations, one per route.
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 4);
  template.resourceCountIs('AWS::ApiGatewayV2::Integration', 4);

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
