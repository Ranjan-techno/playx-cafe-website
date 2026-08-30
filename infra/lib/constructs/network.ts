import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkConstructProps {
  /** Full resource name, e.g. from createResourceNamer: 'playx-dev-vpc'. */
  vpcName: string;
  /** VPC CIDR block, e.g. '10.20.0.0/16'. */
  vpcCidr: string;
  /** Number of Availability Zones to spread subnets across. */
  maxAzs: number;
}

/**
 * Story 2.1 network foundation: one VPC, PRIVATE_ISOLATED subnets only, no NAT Gateway.
 *
 * No route to the internet exists from these subnets (no NAT, no Internet Gateway route).
 * That's intentional for this phase — nothing deployed yet needs outbound internet access.
 * Future stories that add compute needing AWS-service access without a NAT Gateway should
 * add VPC (interface/gateway) endpoints here rather than switching subnets to PRIVATE_WITH_EGRESS.
 */
export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: props.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: props.maxAzs,
      natGateways: 0,
      // cdk.json enables the restrictDefaultSecurityGroup feature flag, which would
      // otherwise provision a custom-resource Lambda to strip the default security
      // group's rules. Story 2.1 excludes Lambda, so opt out explicitly — isolated
      // subnets have no internet route regardless, and nothing uses the default SG yet.
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'private-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
  }
}
