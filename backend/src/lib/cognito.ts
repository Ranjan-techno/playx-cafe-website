import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

// Guest-first passwordless auth: shared Cognito client for auth-start.ts/auth-verify.ts, cached
// at module scope so warm Lambda invocations reuse it — same caching rationale as db.ts's cached
// pg.Client, applied here to the AWS SDK client instead of a raw database connection. No explicit
// region: the Lambda runtime's AWS_REGION env var resolves it.

let client: CognitoIdentityProviderClient | undefined;

export function getCognitoClient(): CognitoIdentityProviderClient {
  if (!client) {
    client = new CognitoIdentityProviderClient({});
  }
  return client;
}
