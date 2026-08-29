/**
 * Typed environment configuration for the Play X Cafe CDK app.
 *
 * This is the single place that answers "what am I building for" — project code,
 * environment code/name, region, and account — instead of that knowledge being
 * scattered across bin/infra.ts, stack files, or cdk.json context.
 *
 * `environmentCode` (lowercase, e.g. 'dev') feeds resource names via naming.ts
 * (playx-dev-vpc, playx-dev-db, ...). `environmentName` (capitalized, e.g. 'Development')
 * feeds the Environment tag via tags.ts. They're kept as separate fields so nothing
 * has to derive one from the other ad hoc.
 */
export interface EnvironmentConfig {
  /** Short project code used as the first segment of every resource name. */
  projectCode: string;
  /** Short environment code used in resource names: playx-{environmentCode}-{resource}. */
  environmentCode: 'dev' | 'prod';
  /** Full environment name used as the value of the Environment tag. */
  environmentName: 'Development' | 'Production';
  /** AWS region this environment deploys into. Configurable via CDK_DEFAULT_REGION. */
  region: string;
  /** AWS account this environment deploys into. Never hardcoded — read from the environment. */
  account?: string;
}

export const environments: Record<'dev' | 'prod', EnvironmentConfig> = {
  dev: {
    projectCode: 'playx',
    environmentCode: 'dev',
    environmentName: 'Development',
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
    account: process.env.CDK_DEFAULT_ACCOUNT,
  },
  prod: {
    projectCode: 'playx',
    environmentCode: 'prod',
    environmentName: 'Production',
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-south-1',
    // TODO: set once a Prod AWS account exists. Not read by any stack this phase.
    account: undefined,
  },
};
