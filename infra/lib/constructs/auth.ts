import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { AuthConfig } from '../config/auth-config';

export interface AuthConstructProps {
  authConfig: AuthConfig;
  /** Full resource name for the User Pool, e.g. 'playx-dev-users'. */
  userPoolName: string;
  /** Full resource name for the app client, e.g. 'playx-dev-web-client'. */
  webClientName: string;
}

/**
 * Story 2.4 customer identity: one Cognito User Pool for Play X customers, plus a single
 * public (secret-less) app client for the marketing site's future signup/login flow.
 *
 * Deliberately minimal: no Hosted UI domain, no OAuth app integration, no Identity Pool
 * (federated/IAM credentials) — none of that is needed until a frontend actually calls this
 * pool, which this story doesn't do (see CLAUDE.md / js/auth.js, still Firebase-backed today).
 */
export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    const { authConfig } = props;

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: props.userPoolName,

      selfSignUpEnabled: true,

      // email:true, username:false makes Cognito's UsernameAttributes = ['email'] — the email
      // address itself is the sign-in identifier, not a separate generated username with email
      // layered on as an alias.
      signInAliases: { email: true, username: false },

      // Signup leaves the user unconfirmed until this code is verified — sign-in is rejected
      // until then. This is what makes email verification required, not optional.
      autoVerify: { email: true },

      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
        // Collected, but not required or auto-verified: the signup form's phone field
        // (auth.html, type="tel") is free-text and not guaranteed valid E.164, and SMS
        // verification is out of scope here. See auth-config.ts / plan for the trade-off.
        phoneNumber: { required: false, mutable: true },
      },

      passwordPolicy: {
        minLength: authConfig.passwordMinLength,
        requireLowercase: authConfig.passwordRequireLowercase,
        requireUppercase: authConfig.passwordRequireUppercase,
        requireDigits: authConfig.passwordRequireDigits,
        requireSymbols: authConfig.passwordRequireSymbols,
      },

      // Email is the only verified channel (phone isn't verified — see standardAttributes
      // above), so it's the only channel Cognito should use for "Forgot password".
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,

      // Send verification/forgot-password emails via the already-verified SES identity
      // (see auth-config.ts) instead of Cognito's built-in low-volume sender. SES identity
      // verification itself is managed outside CDK, not by this construct.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: authConfig.sesFromEmail,
        fromName: authConfig.sesFromName,
        sesRegion: authConfig.sesRegion,
      }),

      deletionProtection: authConfig.deletionProtection,
      removalPolicy: authConfig.removalPolicy,
    });

    this.webClient = new cognito.UserPoolClient(this, 'WebClient', {
      userPool: this.userPool,
      userPoolClientName: props.webClientName,

      // A secret embedded in browser JS isn't a secret — mandatory false for a public client.
      generateSecret: false,

      // SRP only: the password itself never goes over the wire, unlike USER_PASSWORD_AUTH.
      // The right default for a public client with no other flow required yet.
      authFlows: { userSrp: true },

      // Don't let a failed sign-in or forgot-password call reveal whether an email is
      // registered.
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, 'UserPoolIdOutput', {
      value: this.userPool.userPoolId,
      description: 'Play X Cognito User Pool ID',
      exportName: `${props.userPoolName}-id`,
    });

    new cdk.CfnOutput(this, 'WebClientIdOutput', {
      value: this.webClient.userPoolClientId,
      description: 'Play X Cognito App Client ID (public web client, no secret)',
      exportName: `${props.webClientName}-id`,
    });
  }
}
