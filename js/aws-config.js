// ============================================================================
// AWS backend config - REQUIRED before sign-up/log-in/booking will work for
// real. Ships with obvious placeholder values, computes a flag every other
// script checks, and degrades to a clear "not configured yet" message
// instead of throwing when it's false.
//
// Filled in below with the Play X dev environment's deployed values -
// region ap-south-1, User Pool ap-south-1_WsEYc83h6, App Client
// qj1pmj2b3d39vjdgcs6on2uh7, API https://p2b6wptdck.execute-api.ap-south-1.amazonaws.com.
// Update these if the dev stack is ever torn down and redeployed (a fresh
// `cdk deploy` issues new IDs), or add a second, prod-only config here once
// a prod stack exists.
//
// Where these values come from: `cdk deploy` (run from infra/) prints all
// three as CloudFormation outputs after a successful deploy -
//   Auth.UserPoolIdOutput   -> userPoolId
//   Auth.WebClientIdOutput  -> userPoolClientId
//   Api.UrlOutput           -> apiBaseUrl (the HTTP API's base URL, no
//                              trailing slash, e.g.
//                              "https://abc123xyz.execute-api.ap-south-1.amazonaws.com")
// region is the same value as infra/lib/config/environment-config.ts'
// `environments.dev.region` (ap-south-1 unless CDK_DEFAULT_REGION overrides it).
//
// None of these are secrets - a Cognito User Pool ID/App Client ID and an API
// Gateway URL are public identifiers meant to be embedded in browser JS (the
// App Client itself has no client secret - generateSecret: false in
// infra/lib/constructs/auth.ts - which is required, not optional, for a
// public browser app like this one). No AWS account credentials, database
// credentials, or Secrets Manager values belong here (or anywhere in
// frontend JS) - the backend Lambdas hold those, never the browser.
// ============================================================================

const AWS_CONFIG = {
  region: 'ap-south-1',
  userPoolId: 'ap-south-1_WsEYc83h6',
  userPoolClientId: 'qj1pmj2b3d39vjdgcs6on2uh7',
  apiBaseUrl: 'https://p2b6wptdck.execute-api.ap-south-1.amazonaws.com'
};

const isAwsConfigured =
  AWS_CONFIG.userPoolId !== 'YOUR_USER_POOL_ID' &&
  AWS_CONFIG.userPoolClientId !== 'YOUR_USER_POOL_CLIENT_ID' &&
  AWS_CONFIG.apiBaseUrl !== 'YOUR_API_BASE_URL';
