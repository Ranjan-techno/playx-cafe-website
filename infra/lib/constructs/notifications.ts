import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { AuthConfig } from '../config/auth-config';
import { NotificationConfig } from '../config/notification-config';

export interface NotificationsConstructProps {
  notificationConfig: NotificationConfig;
  /** The existing SES identity (sender, Reply-To, region) — the same one the OTP email uses. */
  authConfig: AuthConfig;
  /** Lower-cased, comma-separated emails SANDBOX confirmations may go to ('' = none). */
  sandboxAllowlist: string;
  /** e.g. 'playx-dev-booking-confirmation-notify'. */
  functionName: string;
  /** e.g. 'playx-dev-booking-confirmation-notify-errors'. */
  errorsAlarmName: string;
  vpc: ec2.IVpc;
  lambdaSecurityGroup: ec2.SecurityGroup;
  databaseSecret: secretsmanager.ISecret;
  userPool: cognito.UserPool;
}

/**
 * Stage 2F: the transactional booking-confirmation email sender.
 *
 * Payment confirmation (confirmSuccessfulPayment, in the existing payment Lambdas) only writes a
 * durable outbox row (booking_notifications, migration 008) inside its own transaction. This
 * construct adds the ONE Lambda that delivers those rows, on an EventBridge rate(1 minute) schedule
 * — the same scheduled-sweep pattern as the payment reconcilers, no queue: the DB row is the queue
 * and its UNIQUE (booking_id, notification_type) is the idempotency key. See
 * backend/src/lib/booking-notifications.ts.
 *
 * Least privilege — none of these is granted to any payment Lambda:
 *   - ses:SendEmail, pinned by ses:FromAddress to the existing verified sender (resource "*" for the
 *     same reason as constructs/auth.ts's OTP grant: SES authorizes against recipient identities);
 *   - cognito-idp:ListUsers + cognito-idp:AdminGetUser on this User Pool only — find the booking
 *     owner by `sub`, then read that account by its canonical Username (recipient = its verified
 *     email; see backend/src/lib/verified-account-email.ts);
 *   - read of the DB credentials secret.
 * Placement: the payment Lambdas' PRIVATE_WITH_EGRESS subnets + shared Lambda SG (RDS over the VPC,
 * SES/Cognito over the existing NAT). No new VPC endpoint, NAT, secret, queue or API route.
 *
 * Alarm: Lambda Errors > 0 — the handler throws only when a notification failed permanently (retries
 * exhausted / rejected / no verified recipient) or on an unexpected failure. No actions (no SNS topic
 * in this stack), same as the Stage 2E alarms.
 */
export class NotificationsConstruct extends Construct {
  public readonly confirmationNotifyFunction: lambdaNodejs.NodejsFunction;
  public readonly confirmationNotifyRule: events.Rule;
  public readonly confirmationNotifyErrorsAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: NotificationsConstructProps) {
    super(scope, id);
    const { authConfig } = props;

    this.confirmationNotifyFunction = new lambdaNodejs.NodejsFunction(this, 'BookingConfirmationNotifyFunction', {
      functionName: props.functionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/booking-confirmation-notify.ts'),
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // Well under CLAIM_LEASE_SECONDS (300) in booking-notifications.ts, so a claimed row is never
      // re-claimed while this invocation may still be sending it. The handler stops claiming new
      // batches when <15s remain.
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: props.databaseSecret.secretArn,
        USER_POOL_ID: props.userPool.userPoolId,
        SES_FROM_EMAIL: authConfig.sesFromEmail,
        SES_FROM_NAME: authConfig.sesFromName,
        SES_REPLY_TO_EMAIL: authConfig.sesReplyToEmail,
        SES_REGION: authConfig.sesRegion,
        // Explicit, never defaulted: the backend sends only on the exact "true".
        BOOKING_CONFIRMATION_EMAIL_ENABLED: props.notificationConfig.confirmationEmailEnabled ? 'true' : 'false',
        BOOKING_EMAIL_SANDBOX_ALLOWLIST: props.sandboxAllowlist,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
    props.databaseSecret.grantRead(this.confirmationNotifyFunction);
    this.confirmationNotifyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
        conditions: { StringEquals: { 'ses:FromAddress': authConfig.sesFromEmail } },
      }),
    );
    this.confirmationNotifyFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminGetUser'],
        resources: [props.userPool.userPoolArn],
      }),
    );

    this.confirmationNotifyRule = new events.Rule(this, 'BookingConfirmationNotifySchedule', {
      description: 'Every minute: send pending booking-confirmation emails (booking_notifications outbox)',
      schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
      targets: [
        new eventsTargets.LambdaFunction(this.confirmationNotifyFunction, {
          // The next scheduled run is the retry; async retries would only overlap it.
          retryAttempts: 0,
          maxEventAge: cdk.Duration.minutes(1),
        }),
      ],
    });

    this.confirmationNotifyErrorsAlarm = new cloudwatch.Alarm(this, 'BookingConfirmationNotifyErrorsAlarm', {
      alarmName: props.errorsAlarmName,
      alarmDescription:
        'Booking-confirmation email sender: a notification failed permanently, or the sender crashed/timed out',
      metric: this.confirmationNotifyFunction.metricErrors({ period: cdk.Duration.minutes(1), statistic: cloudwatch.Stats.SUM }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
