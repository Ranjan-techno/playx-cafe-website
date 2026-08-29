import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './environment-config';

/**
 * Applies the Play X Cafe standard AWS tags to a stack (or any construct scope):
 *   Project     = PlayX
 *   Environment = Development | Production
 *   ManagedBy   = CDK
 *
 * Applied per-stack (not app-wide) so Environment is always correct once a prod
 * stack exists alongside dev.
 */
export function applyStandardTags(scope: Construct, config: EnvironmentConfig): void {
  cdk.Tags.of(scope).add('Project', 'PlayX');
  cdk.Tags.of(scope).add('Environment', config.environmentName);
  cdk.Tags.of(scope).add('ManagedBy', 'CDK');
}
