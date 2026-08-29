#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { InfraStack } from '../lib/infra-stack';
import { environments } from '../lib/config/environment-config';

const app = new cdk.App();
const devConfig = environments.dev;

new InfraStack(app, 'InfraStack', {
  envConfig: devConfig,
  env: { account: devConfig.account, region: devConfig.region },
});

// --- Future: uncomment once a Prod AWS account exists ---
// const prodConfig = environments.prod;
// new InfraStack(app, 'InfraStackProd', {
//   envConfig: prodConfig,
//   env: { account: prodConfig.account, region: prodConfig.region },
// });
