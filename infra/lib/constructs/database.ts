import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { DatabaseConfig } from '../config/database-config';

export interface DatabaseConstructProps {
  vpc: ec2.IVpc;
  dbConfig: DatabaseConfig;
  /** Full resource name, e.g. from createResourceNamer: 'playx-dev-db'. */
  instanceIdentifier: string;
  /** Full resource name for the DB subnet group, e.g. 'playx-dev-db-subnet-group'. */
  subnetGroupName: string;
  /** Full resource name for the Lambda security group, e.g. 'playx-dev-lambda-sg'. */
  lambdaSecurityGroupName: string;
  /** Full resource name for the DB security group, e.g. 'playx-dev-db-sg'. */
  dbSecurityGroupName: string;
  /** Full resource name for the Secrets Manager secret, e.g. 'playx-dev-db-credentials'. */
  secretName: string;
}

/**
 * Story 2.2 database foundation: one RDS PostgreSQL instance in the Story 2.1 VPC's
 * PRIVATE_ISOLATED subnets, with generated Secrets Manager credentials and a
 * security-group pair that only opens 5432 from a (not-yet-created) Lambda SG.
 *
 * No Lambda function or API Gateway is created here (out of scope for this story) —
 * `lambdaSecurityGroup` is provisioned now, empty, so a future compute story can attach
 * it to a Lambda's VPC config without touching this construct or the DB security group.
 */
export class DatabaseConstruct extends Construct {
  public readonly instance: rds.DatabaseInstance;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;
  public readonly dbSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseConstructProps) {
    super(scope, id);

    const { vpc, dbConfig } = props;

    // Placeholder for a future Lambda's VPC security group. Created with no rules of its
    // own — it only needs to exist so the DB security group can name it as an allowed
    // ingress source. A later story attaches this same SG to the Lambda's `vpc.securityGroups`.
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      securityGroupName: props.lambdaSecurityGroupName,
      vpc,
      description: 'Attach to the (future) booking Lambda: outbound-only, source for the DB security group.',
      allowAllOutbound: true,
    });

    // No ingress rules and no default outbound rule: the database never needs to
    // initiate a connection anywhere, so its security group stays deny-by-default in
    // both directions except the one rule added below.
    this.dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      securityGroupName: props.dbSecurityGroupName,
      vpc,
      description: 'Play X PostgreSQL (playx-dev-db): allows 5432 from the Lambda security group only.',
      allowAllOutbound: false,
    });

    this.dbSecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'PostgreSQL from the Lambda security group',
    );

    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      subnetGroupName: props.subnetGroupName,
      description: 'Play X dev DB subnet group: PRIVATE_ISOLATED subnets only (no route to the internet).',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    });

    this.instance = new rds.DatabaseInstance(this, 'Instance', {
      instanceIdentifier: props.instanceIdentifier,
      databaseName: dbConfig.databaseName,
      engine: rds.DatabaseInstanceEngine.postgres({ version: dbConfig.engineVersion }),
      instanceType: dbConfig.instanceType,

      vpc,
      // Explicit subnet group (PRIVATE_ISOLATED-only, built above) takes precedence over
      // `vpcSubnets`, which would otherwise create an implicit one — passing only this
      // avoids the two disagreeing.
      subnetGroup,
      securityGroups: [this.dbSecurityGroup],
      publiclyAccessible: false,

      // Secrets Manager, not a literal password: CDK generates a random password at
      // deploy time and stores {username, password, host, port, dbname, engine} as JSON
      // in a new secret. Nothing in source control or CloudFormation ever sees it.
      credentials: rds.Credentials.fromGeneratedSecret('playx_admin', {
        secretName: props.secretName,
      }),

      allocatedStorage: dbConfig.allocatedStorageGiB,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,

      multiAz: dbConfig.multiAz,
      backupRetention: cdk.Duration.days(dbConfig.backupRetentionDays),
      deletionProtection: dbConfig.deletionProtection,

      // Dev database: disposable. Skip the final snapshot RDS otherwise takes (and bills
      // for) on delete, and let `cdk destroy` remove the instance outright rather than
      // leaving it behind in RETAIN state. Revisit for prod (see database-config.ts).
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
  }
}
