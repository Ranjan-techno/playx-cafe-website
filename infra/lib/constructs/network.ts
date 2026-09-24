import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface NetworkConstructProps {
  /** Full resource name, e.g. from createResourceNamer: 'playx-dev-vpc'. */
  vpcName: string;
  /** VPC CIDR block, e.g. '10.20.0.0/16'. */
  vpcCidr: string;
  /** Number of Availability Zones to spread subnets across. */
  maxAzs: number;
  /** NAT Gateways serving the PRIVATE_WITH_EGRESS subnets (see NetworkConfig.natGateways). */
  natGateways: number;
}

/**
 * Story 2.1 network foundation (PRIVATE_ISOLATED subnets, no internet route) plus the additive
 * PhonePe-payments egress path.
 *
 * The 'private-isolated' subnets are UNCHANGED and remain where RDS, the DB subnet group, the
 * Secrets Manager interface endpoint and every non-payment Lambda live. They must stay FIRST in
 * subnetConfiguration: CDK allocates CIDRs in configuration order, so appending new groups after
 * them leaves the deployed subnets' CIDRs (and logical IDs) untouched.
 *
 * Added for payments only:
 *   - 'public' (/28 per AZ): exists solely to host the NAT Gateway; nothing else is placed there.
 *   - 'private-egress' (/24 per AZ, PRIVATE_WITH_EGRESS): default route via the NAT Gateway. Only
 *     the payment Lambdas attach here — they reach RDS over the VPC-local route (same VPC, same
 *     Lambda security group) and PhonePe over the NAT.
 * A single NAT Gateway serves both AZs (cost control for the MVP).
 */
export class NetworkConstruct extends Construct {
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: NetworkConstructProps) {
    super(scope, id);

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: props.vpcName,
      ipAddresses: ec2.IpAddresses.cidr(props.vpcCidr),
      maxAzs: props.maxAzs,
      natGateways: props.natGateways,
      // cdk.json enables the restrictDefaultSecurityGroup feature flag, which would
      // otherwise provision a custom-resource Lambda to strip the default security
      // group's rules. Story 2.1 excludes Lambda, so opt out explicitly — nothing uses the
      // default SG (every resource here has its own).
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [
        {
          name: 'private-isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
        // Appended AFTER private-isolated on purpose — see the class comment.
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 28 },
        { name: 'private-egress', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });
  }
}
