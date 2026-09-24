import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { buildBookingConfirmationEmail } from './booking-confirmation-email';
import type { BookingConfirmationDetails } from './booking-notifications';

// Guest-first passwordless auth: shared SES client for auth-create-challenge.ts, cached at
// module scope so warm Lambda invocations reuse it — same caching rationale as lib/cognito.ts's
// cached CognitoIdentityProviderClient. Explicit region (SES_REGION, set from auth-config.ts's
// sesRegion — the same already-verified SES identity the User Pool itself sends from, see
// constructs/auth.ts): SES is regional and the verified sender identity lives in one specific
// region regardless of which region the Lambda itself runs in.

let client: SESClient | undefined;

export function getSesClient(): SESClient {
  if (!client) {
    client = new SESClient({ region: process.env.SES_REGION });
  }
  return client;
}

/**
 * Emails the six-digit Play X verification code via the already-verified SES sender identity.
 * Never logs `code` — see auth-create-challenge.ts, the only caller.
 */
export async function sendOtpEmail(toEmail: string, code: string): Promise<void> {
  const fromEmail = process.env.SES_FROM_EMAIL;
  const fromName = process.env.SES_FROM_NAME ?? 'Play X Cafe';
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL env var not configured');
  }

  const replyTo = process.env.SES_REPLY_TO_EMAIL;

  const textBody =
    'Play X Cafe\n\n' +
    `Your 6-digit verification code is: ${code}\n\n` +
    'This code is valid for a limited time. If you did not request it, you can safely ignore this email.\n\n' +
    'Race. Xperience. Hangout.';

  await getSesClient().send(
    new SendEmailCommand({
      Source: `${fromName} <${fromEmail}>`,
      Destination: { ToAddresses: [toEmail] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Message: {
        Subject: { Data: 'Your Play X verification code', Charset: 'UTF-8' },
        Body: {
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }),
  );
}

/**
 * Stage 2F: sends the booking-confirmation email (booking-notifications.ts's sender) through the
 * same verified SES identity, client and SES_* configuration as the OTP above — no second sender,
 * domain or provider. Text + HTML parts. Resolves to SES's MessageId. Never logs the recipient or
 * the body; the caller logs only ids and outcome codes.
 */
export async function sendBookingConfirmationEmail(
  toEmail: string,
  details: BookingConfirmationDetails,
): Promise<string | undefined> {
  const fromEmail = process.env.SES_FROM_EMAIL;
  const fromName = process.env.SES_FROM_NAME ?? 'Play X Cafe';
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL env var not configured');
  }
  const replyTo = process.env.SES_REPLY_TO_EMAIL;
  const content = buildBookingConfirmationEmail(details);

  const response = await getSesClient().send(
    new SendEmailCommand({
      Source: `${fromName} <${fromEmail}>`,
      Destination: { ToAddresses: [toEmail] },
      ...(replyTo ? { ReplyToAddresses: [replyTo] } : {}),
      Message: {
        Subject: { Data: content.subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: content.text, Charset: 'UTF-8' },
          Html: { Data: content.html, Charset: 'UTF-8' },
        },
      },
    }),
  );
  return response?.MessageId;
}
