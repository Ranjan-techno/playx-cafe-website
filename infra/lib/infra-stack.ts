import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { EnvironmentConfig } from './config/environment-config';
import { createResourceNamer } from './config/naming';
import { applyStandardTags } from './config/tags';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export interface InfraStackProps extends cdk.StackProps {
  envConfig: EnvironmentConfig;
}

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: InfraStackProps) {
    super(scope, id, props);

    applyStandardTags(this, props.envConfig);
    const resourceName = createResourceNamer(props.envConfig);
    void resourceName; // ready for future constructs — no resources created this phase

    // Future resources will be created here, named via resourceName('vpc'), resourceName('db'), etc.

    // example resource
    // const queue = new sqs.Queue(this, resourceName('queue'), {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
