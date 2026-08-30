import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config/environment-config';
import { createResourceNamer } from './config/naming';
import { applyStandardTags } from './config/tags';
import { networkConfigs } from './config/network-config';
import { NetworkConstruct } from './constructs/network';
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
    new NetworkConstruct(this, 'Network', {
      vpcName: resourceName('vpc'),
      vpcCidr: networkConfig.vpcCidr,
      maxAzs: networkConfig.maxAzs,
    });

    // Future resources (RDS, Lambda, API Gateway, ...) will be created here,
    // named via resourceName('db'), resourceName('booking-function'), etc.

    // example resource
    // const queue = new sqs.Queue(this, resourceName('queue'), {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
