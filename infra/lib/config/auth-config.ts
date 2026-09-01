import * as cdk from 'aws-cdk-lib/core';

/**
 * Per-environment Cognito User Pool configuration for the Play X Cafe CDK app.
 *
 * Kept separate from environment-config.ts and the other per-concern config files (see
 * database-config.ts) so password policy and dev-vs-prod removal posture are a one-line
 * change later, without touching the construct that reads them.
 */
export interface AuthConfig {
  /** Minimum password length. Matches the `minlength` already on auth.html's signup form. */
  passwordMinLength: number;
  /** Require at least one lowercase letter. */
  passwordRequireLowercase: boolean;
  /** Require at least one uppercase letter. */
  passwordRequireUppercase: boolean;
  /** Require at least one digit. */
  passwordRequireDigits: boolean;
  /** Require at least one symbol. Off by default — see auth.ts for the trade-off. */
  passwordRequireSymbols: boolean;
  /** Deletion protection on the User Pool itself (distinct from CDK's removalPolicy below —
   *  this is the AWS-level guardrail that blocks a DeleteUserPool call outright). Off for dev
   *  so the stack can be torn down without a manual step first. */
  deletionProtection: boolean;
  /** What happens to the User Pool when it's removed from the stack. Dev pools are disposable;
   *  losing one means every existing customer's account (there are none yet) with it. */
  removalPolicy: cdk.RemovalPolicy;
  /** "From" email address for Cognito-sent emails (verification codes, forgot-password), sent
   *  via SES instead of Cognito's built-in low-volume sender. Must already be a verified SES
   *  identity in sesRegion — CDK does not create or verify it. */
  sesFromEmail: string;
  /** Display name shown alongside sesFromEmail in the "From" header. */
  sesFromName: string;
  /** AWS region the SES identity lives in / sends from. */
  sesRegion: string;
}

export const authConfigs: Record<'dev' | 'prod', AuthConfig> = {
  dev: {
    passwordMinLength: 8,
    passwordRequireLowercase: true,
    passwordRequireUppercase: true,
    passwordRequireDigits: true,
    passwordRequireSymbols: false,
    deletionProtection: false,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
    sesFromEmail: 'playxcafesupport@gmail.com',
    sesFromName: 'Play X Cafe',
    sesRegion: 'ap-south-1',
  },
  prod: {
    // TODO: revisit before a prod pool exists — deletionProtection true, removalPolicy RETAIN
    // at minimum (a deleted prod User Pool takes every real customer account with it).
    // Not read by any stack this phase (see bin/infra.ts).
    passwordMinLength: 8,
    passwordRequireLowercase: true,
    passwordRequireUppercase: true,
    passwordRequireDigits: true,
    passwordRequireSymbols: false,
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    sesFromEmail: 'playxcafesupport@gmail.com',
    sesFromName: 'Play X Cafe',
    sesRegion: 'ap-south-1',
  },
};
