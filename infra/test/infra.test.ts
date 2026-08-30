import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { InfraStack } from '../lib/infra-stack';
import { environments } from '../lib/config/environment-config';

test('Story 2.1: VPC created with isolated-only subnets and no NAT/Lambda', () => {
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

  // No NAT Gateway, and no Lambda (guards against the restrictDefaultSecurityGroup
  // feature flag's custom-resource Lambda — see constructs/network.ts).
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
  template.resourceCountIs('AWS::Lambda::Function', 0);
});
