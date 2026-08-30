/**
 * Per-environment networking configuration for the Play X Cafe CDK app.
 *
 * Kept separate from environment-config.ts (which answers "what am I building for" —
 * project/env/region/account) so networking shape lives in one place and prod is a
 * one-line CIDR decision later, without touching identity config or the naming/tags
 * helpers.
 */
export interface NetworkConfig {
  /** VPC CIDR block, e.g. '10.20.0.0/16'. */
  vpcCidr: string;
  /** Number of Availability Zones the VPC's subnets span. */
  maxAzs: number;
}

export const networkConfigs: Record<'dev' | 'prod', NetworkConfig> = {
  dev: {
    vpcCidr: '10.20.0.0/16',
    maxAzs: 2,
  },
  prod: {
    // TODO: confirm before a prod VPC is created. Provisional /16 chosen to avoid
    // overlapping dev's 10.20.0.0/16 in case the two are ever peered or connected
    // via Transit Gateway. Not read by any stack this phase (see bin/infra.ts).
    vpcCidr: '10.21.0.0/16',
    maxAzs: 2,
  },
};
