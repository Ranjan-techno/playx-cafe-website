// Stage 2G test support: SES email-sending events as EventBridge delivers them (shape per the SES
// docs' "Monitoring SES events using Amazon EventBridge" example). Deliberately includes the PII-ish
// fields real events carry (recipients, sender, subject header, SMTP response, reporting MTA,
// diagnostic code, rendering error message) so tests can prove none of it is stored or logged.

export const TEST_CONFIGURATION_SET = 'playx-booking-emails';
export const TEST_RECIPIENT = 'racer.pii@example.com';
export const TEST_SMTP_RESPONSE = '250 2.6.0 <msg@mx.example.net> [InternalId=1234] Queued mail for delivery to racer.pii@example.com';
export const TEST_DIAGNOSTIC = 'smtp; 550 5.1.1 user unknown racer.pii@example.com';
export const TEST_RENDER_ERROR = "Attribute 'customerPhone' (+91 98765 43210) is not present in the rendering data.";

export type SesDetailType =
  | 'Email Sent'
  | 'Email Delivered'
  | 'Email Delivery Delayed'
  | 'Email Bounced'
  | 'Email Complaint Received'
  | 'Email Rejected'
  | 'Email Rendering Failed'
  | 'Email Opened'
  | 'Email Clicked';

const EVENT_TYPE: Record<SesDetailType, string> = {
  'Email Sent': 'Send',
  'Email Delivered': 'Delivery',
  'Email Delivery Delayed': 'DeliveryDelay',
  'Email Bounced': 'Bounce',
  'Email Complaint Received': 'Complaint',
  'Email Rejected': 'Reject',
  'Email Rendering Failed': 'Rendering Failure',
  'Email Opened': 'Open',
  'Email Clicked': 'Click',
};

export interface SesEventOptions {
  notificationId?: string | null;
  messageId?: string;
  configurationSet?: string | null;
  /** ISO timestamp for the event-specific sub-object (and mail.timestamp for Send). */
  at?: string;
  eventBridgeTime?: string;
  bounceType?: string;
  bounceSubType?: string;
}

let counter = 0;

export function sesEvent(detailType: SesDetailType, opts: SesEventOptions = {}): Record<string, unknown> {
  counter += 1;
  const at = opts.at ?? '2026-09-25T06:05:00.000Z';
  const tags: Record<string, string[]> = {
    'ses:source-ip': ['10.0.0.1'],
    'ses:from-domain': ['playxcafe.com'],
    'ses:caller-identity': ['playx-dev-booking-confirmation-notify-role'],
  };
  if (opts.configurationSet !== null) tags['ses:configuration-set'] = [opts.configurationSet ?? TEST_CONFIGURATION_SET];
  if (opts.notificationId !== null && opts.notificationId !== undefined) tags.playx_notification_id = [opts.notificationId];

  const detail: Record<string, unknown> = {
    eventType: EVENT_TYPE[detailType],
    mail: {
      timestamp: detailType === 'Email Sent' ? at : '2026-09-25T06:00:00.000Z',
      source: 'Play X Cafe <bookings@playxcafe.com>',
      sourceArn: 'arn:aws:ses:ap-south-1:123456789012:identity/playxcafe.com',
      sendingAccountId: '123456789012',
      messageId: opts.messageId ?? 'ses-msg-1',
      destination: [TEST_RECIPIENT],
      headersTruncated: false,
      headers: [{ name: 'To', value: TEST_RECIPIENT }, { name: 'Subject', value: 'Play X Cafe — Booking #1040 Confirmed' }],
      commonHeaders: { to: [TEST_RECIPIENT], subject: 'Play X Cafe — Booking #1040 Confirmed' },
      tags,
    },
  };
  switch (detailType) {
    case 'Email Sent':
      detail.send = {};
      break;
    case 'Email Delivered':
      detail.delivery = { timestamp: at, processingTimeMillis: 812, recipients: [TEST_RECIPIENT], smtpResponse: TEST_SMTP_RESPONSE, reportingMTA: 'a8-50.smtp-out.amazonses.com' };
      break;
    case 'Email Delivery Delayed':
      detail.deliveryDelay = { timestamp: at, delayType: 'MailboxFull', expirationTime: '2026-09-26T06:00:00.000Z', delayedRecipients: [{ emailAddress: TEST_RECIPIENT, status: '4.2.2', diagnosticCode: TEST_DIAGNOSTIC }] };
      break;
    case 'Email Bounced':
      detail.bounce = {
        timestamp: at,
        bounceType: opts.bounceType ?? 'Permanent',
        bounceSubType: opts.bounceSubType ?? 'General',
        bouncedRecipients: [{ emailAddress: TEST_RECIPIENT, action: 'failed', status: '5.1.1', diagnosticCode: TEST_DIAGNOSTIC }],
        feedbackId: 'feedback-1',
        reportingMTA: 'dsn; a8-50.smtp-out.amazonses.com',
      };
      break;
    case 'Email Complaint Received':
      detail.complaint = { timestamp: at, complainedRecipients: [{ emailAddress: TEST_RECIPIENT }], feedbackId: 'feedback-2', complaintFeedbackType: 'abuse', userAgent: 'Mail Client/1.0' };
      break;
    case 'Email Rejected':
      detail.reject = { reason: 'Bad content' };
      break;
    case 'Email Rendering Failed':
      detail.failure = { errorMessage: TEST_RENDER_ERROR, templateName: 'BookingConfirmation' };
      break;
    default:
      detail.open = { timestamp: at, userAgent: 'x', ipAddress: '1.2.3.4' };
  }

  return {
    version: '0',
    id: `0f5a7c1e-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    'detail-type': detailType,
    source: 'aws.ses',
    account: '123456789012',
    time: opts.eventBridgeTime ?? at.replace(/\.\d{3}Z$/, 'Z'),
    region: 'ap-south-1',
    resources: ['arn:aws:ses:ap-south-1:123456789012:configuration-set/playx-booking-emails'],
    detail,
  };
}
