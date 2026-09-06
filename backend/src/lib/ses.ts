import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

// Guest-first passwordless auth: shared SES client for auth-create-challenge.ts, cached at
// module scope so warm Lambda invocations reuse it — same caching rationale as lib/cognito.ts's
// cached CognitoIdentityProviderClient. Explicit region (SES_REGION, set from auth-config.ts's
// sesRegion — the same already-verified SES identity the User Pool itself sends from, see
// constructs/auth.ts): SES is regional and the verified sender identity lives in one specific
// region regardless of which region the Lambda itself runs in.

let client: SESClient | undefined;

function getSesClient(): SESClient {
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

  const textBody =
    `Your Play X verification code is:\n\n${code}\n\n` +
    "This code expires shortly. If you didn't request this code, you can ignore this email.";

  await getSesClient().send(
    new SendEmailCommand({
      Source: `${fromName} <${fromEmail}>`,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: 'Your Play X verification code', Charset: 'UTF-8' },
        Body: {
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }),
  );
}
