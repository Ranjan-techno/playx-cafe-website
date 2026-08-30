import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

/**
 * Per-environment RDS PostgreSQL configuration for the Play X Cafe CDK app.
 *
 * Kept separate from environment-config.ts (identity: project/env/region/account) and
 * network-config.ts (VPC shape), mirroring that split so database sizing is a one-line
 * change later — e.g. bumping prod off a burstable instance class — without touching
 * networking or naming.
 */
export interface DatabaseConfig {
  /** Logical database created inside the instance, e.g. 'playx'. */
  databaseName: string;
  /** PostgreSQL engine version. Pinned (not the bare major, e.g. VER_17) so `cdk diff`
   *  never surprises us with an AWS-chosen minor-version upgrade. */
  engineVersion: rds.PostgresEngineVersion;
  /** Instance class/size. Smallest burstable class sensible for a dev workload. */
  instanceType: ec2.InstanceType;
  /** Initial allocated storage, in GiB. RDS auto-scales up from here if enabled. */
  allocatedStorageGiB: number;
  /** Backup retention window, in days. 0 disables automated backups. */
  backupRetentionDays: number;
  /** Multi-AZ standby. Doubles compute+storage cost — off for dev. */
  multiAz: boolean;
  /** Deletion protection. Off for dev so the stack can be torn down without a manual step. */
  deletionProtection: boolean;
}

export const databaseConfigs: Record<'dev' | 'prod', DatabaseConfig> = {
  dev: {
    databaseName: 'playx',
    // Latest PostgreSQL 17 minor exposed by the installed aws-cdk-lib version at the
    // time this stack was written. Re-check `PostgresEngineVersion` in aws-cdk-lib for
    // a newer pinned minor before reusing this file as a template.
    engineVersion: rds.PostgresEngineVersion.VER_17_9,
    // db.t4g.micro: smallest Graviton (arm64) burstable class RDS PostgreSQL supports,
    // available in ap-south-1. Cheapest sensible dev instance; not for prod traffic.
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
    allocatedStorageGiB: 20,
    backupRetentionDays: 1,
    multiAz: false,
    deletionProtection: false,
  },
  prod: {
    // TODO: revisit every field before a prod database exists — larger/non-burstable
    // instance class, multi-AZ true, longer backup retention, deletion protection true.
    // Not read by any stack this phase (see bin/infra.ts).
    databaseName: 'playx',
    engineVersion: rds.PostgresEngineVersion.VER_17_9,
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM),
    allocatedStorageGiB: 50,
    backupRetentionDays: 7,
    multiAz: true,
    deletionProtection: true,
  },
};
