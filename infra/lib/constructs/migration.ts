import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface MigrationConstructProps {
  vpc: ec2.IVpc;
  /** The Story 2.2 Lambda security group — reused here rather than creating a new one, per
   *  its own doc comment in constructs/database.ts. */
  lambdaSecurityGroup: ec2.SecurityGroup;
  /** The RDS instance's generated-credentials secret. */
  databaseSecret: secretsmanager.ISecret;
  /** Full resource name, e.g. 'playx-dev-migrate'. */
  functionName: string;
}

/**
 * Story 2.3 migration mechanism: a one-off Lambda, deployed into the Story 2.1 VPC's
 * PRIVATE_ISOLATED subnets on the Story 2.2 Lambda security group, that applies
 * database/migrations/*.sql on demand.
 *
 * Nothing here invokes the function — not this construct, not a custom resource, not an
 * EventBridge rule. `cdk deploy` only creates it; a human runs it afterward with
 * `aws lambda invoke --function-name <functionName>`. That's the safety mechanism: the
 * database has no public endpoint and no route out of its isolated subnets, so this Lambda —
 * invoked manually, from inside the VPC, by whoever holds lambda:InvokeFunction on it — is the
 * only way to run schema changes against it.
 */
export class MigrationConstruct extends Construct {
  public readonly function: lambdaNodejs.NodejsFunction;

  constructor(scope: Construct, id: string, props: MigrationConstructProps) {
    super(scope, id);

    // The isolated subnets have no NAT and no internet route (see constructs/network.ts), so
    // this function can't reach the public Secrets Manager API to fetch DB credentials without
    // a VPC interface endpoint. The database itself needs no such endpoint — it's reached
    // directly over the existing lambdaSecurityGroup -> dbSecurityGroup:5432 rule, both being
    // in the same VPC.
    const secretsManagerEndpoint = props.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],
    });

    // Security groups never implicitly trust their own members — sharing a security group
    // between the Lambda's ENIs and the endpoint's ENIs grants nothing on its own. This is the
    // one rule that lets the Lambda actually reach the endpoint on 443.
    props.lambdaSecurityGroup.addIngressRule(
      props.lambdaSecurityGroup,
      ec2.Port.tcp(443),
      'HTTPS to the Secrets Manager VPC endpoint, from the Lambda security group itself',
    );

    this.function = new lambdaNodejs.NodejsFunction(this, 'Function', {
      functionName: props.functionName,
      entry: path.join(__dirname, '../lambda/migrate/handler.ts'),
      handler: 'handler',
      // Pinned explicitly (matching this project's engineVersion/vpcCidr pinning convention —
      // see database-config.ts) rather than left to cdk.json's useLatestRuntimeVersion context
      // flag, which only takes effect via the `cdk` CLI and silently falls back to the
      // long-deprecated nodejs16.x in contexts that construct `cdk.App()` directly, e.g. jest.
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,

      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],

      environment: {
        DB_SECRET_ARN: props.databaseSecret.secretArn,
      },

      bundling: {
        // Bundles database/migrations/001_initial_schema.sql into the deployed asset as a
        // plain string import — see infra/types/sql.d.ts and handler.ts.
        loader: { '.sql': 'text' },
        // The Node.js 22 runtime ships its own AWS SDK v3, so exclude it from the bundle
        // rather than shipping a second copy — pg isn't runtime-provided, so it stays bundled.
        externalModules: ['@aws-sdk/*'],
      },
    });

    // Scopes IAM to exactly this one secret's ARN — no wildcard resource.
    props.databaseSecret.grantRead(this.function);

    // Purely documents the dependency for anyone reading the construct tree/diff; the
    // security-group rule above already makes the network path work regardless.
    this.function.node.addDependency(secretsManagerEndpoint);
  }
}
