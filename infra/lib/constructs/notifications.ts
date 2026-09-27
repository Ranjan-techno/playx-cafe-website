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
import * as ses from 'aws-cdk-lib/aws-ses';
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
  /** Stage 2G: e.g. 'playx-dev-booking-email-events'. */
  emailEventsFunctionName: string;
  /** Stage 2G: e.g. 'playx-dev-booking-email-events-errors'. */
  emailEventsErrorsAlarmName: string;
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
/** Stage 2G: the SES email-sending events that delivery tracking publishes and consumes — never
 *  OPEN, CLICK or SUBSCRIPTION (no open/click tracking). */
export const BOOKING_EMAIL_TRACKED_EVENTS: readonly ses.EmailSendingEvent[] = [
  ses.EmailSendingEvent.SEND,
  ses.EmailSendingEvent.DELIVERY,
  ses.EmailSendingEvent.DELIVERY_DELAY,
  ses.EmailSendingEvent.BOUNCE,
  ses.EmailSendingEvent.COMPLAINT,
  ses.EmailSendingEvent.REJECT,
  ses.EmailSendingEvent.RENDERING_FAILURE,
];

/** Stage 2G: the EventBridge detail-types SES uses for exactly those seven events. */
export const BOOKING_EMAIL_EVENT_DETAIL_TYPES: readonly string[] = [
  'Email Sent',
  'Email Delivered',
  'Email Delivery Delayed',
  'Email Bounced',
  'Email Complaint Received',
  'Email Rejected',
  'Email Rendering Failed',
];

export class NotificationsConstruct extends Construct {
  public readonly confirmationNotifyFunction: lambdaNodejs.NodejsFunction;
  public readonly confirmationNotifyRule: events.Rule;
  public readonly confirmationNotifyErrorsAlarm: cloudwatch.Alarm;
  public readonly bookingEmailConfigurationSet: ses.ConfigurationSet;
  public readonly emailEventsFunction: lambdaNodejs.NodejsFunction;
  public readonly emailEventsRule: events.Rule;
  public readonly emailEventsErrorsAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: NotificationsConstructProps) {
    super(scope, id);
    const { authConfig, notificationConfig } = props;
    const configurationSetName = notificationConfig.bookingEmailConfigurationSetName;

    // Stage 2G: SES configuration sets and SES -> EventBridge events are regional. The configuration
    // set is created in this stack's region, so the sender's SES region must be the same one.
    const stackRegion = cdk.Stack.of(this).region;
    if (!cdk.Token.isUnresolved(stackRegion) && stackRegion !== authConfig.sesRegion) {
      throw new Error(`Booking email delivery tracking needs sesRegion (${authConfig.sesRegion}) to equal the stack region (${stackRegion})`);
    }

    // ---------------------------------------------------------------------------------------------
    // Stage 2G: SES configuration set for booking-confirmation emails. Its only event destination is
    // the EventBridge DEFAULT bus (the only bus SES publishes to), for the seven sending events
    // above. No open/click tracking, no custom tracking domain, no suppression/reputation overrides
    // (account-level defaults apply exactly as before).
    // ---------------------------------------------------------------------------------------------
    this.bookingEmailConfigurationSet = new ses.ConfigurationSet(this, 'BookingEmailConfigurationSet', {
      configurationSetName,
    });
    this.bookingEmailConfigurationSet.addEventDestination('BookingEmailEventBridgeDestination', {
      configurationSetEventDestinationName: `${configurationSetName}-eventbridge`,
      destination: ses.EventDestination.eventBus(events.EventBus.fromEventBusName(this, 'DefaultEventBus', 'default')),
      events: [...BOOKING_EMAIL_TRACKED_EVENTS],
      enabled: true,
    });

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
        // Stage 2G: explicit, never defaulted; "true" with no SES_CONFIGURATION_SET fails closed.
        BOOKING_EMAIL_DELIVERY_TRACKING_ENABLED: notificationConfig.deliveryTrackingEnabled ? 'true' : 'false',
        SES_CONFIGURATION_SET: this.bookingEmailConfigurationSet.configurationSetName,
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

    // ---------------------------------------------------------------------------------------------
    // Stage 2G: the delivery-event consumer. Applies SES events for booking-confirmation emails to
    // booking_notifications' delivery columns (migration 009) — operational only, it never touches
    // bookings/payments/allocations. See backend/src/lib/booking-email-events.ts.
    //
    // Least privilege: the DB secret (read) + the Lambda basic execution role (CloudWatch Logs) + VPC
    // ENI management. NO SES, Cognito, PhonePe secret or SQS permission. Placement: the same
    // PRIVATE_ISOLATED subnets + shared Lambda SG as the admin/booking Lambdas — it needs only RDS and
    // the existing Secrets Manager VPC endpoint, no internet egress.
    // ---------------------------------------------------------------------------------------------
    this.emailEventsFunction = new lambdaNodejs.NodejsFunction(this, 'BookingEmailEventsFunction', {
      functionName: props.emailEventsFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/booking-email-events.ts'),
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      // A few primary-key reads (up to ~1.5s of correlation re-reads for an early event) + one UPDATE.
      timeout: cdk.Duration.seconds(15),
      // EventBridge invokes this function ASYNCHRONOUSLY. A thrown error — DeliveryCorrelationPendingError
      // for an event that beat the sender's 'sent' commit, or a DB failure — is retried by Lambda
      // itself per this async-invoke configuration (rendered as AWS::Lambda::EventInvokeConfig), and
      // every failed attempt counts in the Errors alarm below. No on-failure destination/DLQ: that
      // would retain raw SES event payloads (recipients, SMTP responses), which Stage 2G never stores.
      retryAttempts: 2,
      maxEventAge: cdk.Duration.hours(6),
      memorySize: 256,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [props.lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: props.databaseSecret.secretArn,
        // Events from any other configuration set are ignored (also filtered by the rule below).
        SES_CONFIGURATION_SET: this.bookingEmailConfigurationSet.configurationSetName,
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    });
    props.databaseSecret.grantRead(this.emailEventsFunction);

    // Only SES email events from THIS configuration set, and only the seven tracked types.
    this.emailEventsRule = new events.Rule(this, 'BookingEmailEventsRule', {
      description: 'SES booking-confirmation email delivery events (playx-booking-emails) -> delivery tracking',
      eventPattern: {
        source: ['aws.ses'],
        detailType: [...BOOKING_EMAIL_EVENT_DETAIL_TYPES],
        detail: {
          mail: {
            tags: {
              'ses:configuration-set': [configurationSetName],
            },
          },
        },
      },
      targets: [
        new eventsTargets.LambdaFunction(this.emailEventsFunction, {
          // EventBridge's OWN retry policy: it only covers failures to hand the event to Lambda (e.g.
          // throttling of the async Invoke call). Errors thrown by the function are retried by the
          // function's async-invoke configuration above, not by this. Every transition is idempotent
          // and forward-only, so any redelivery is harmless.
          retryAttempts: 4,
          maxEventAge: cdk.Duration.hours(6),
        }),
      ],
    });

    this.emailEventsErrorsAlarm = new cloudwatch.Alarm(this, 'BookingEmailEventsErrorsAlarm', {
      alarmName: props.emailEventsErrorsAlarmName,
      alarmDescription:
        'Booking email delivery-event consumer failed (DB error, missing migration 009, misconfiguration, or an event that beat the sender\'s record and is being retried)',
      metric: this.emailEventsFunction.metricErrors({ period: cdk.Duration.minutes(5), statistic: cloudwatch.Stats.SUM }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}
