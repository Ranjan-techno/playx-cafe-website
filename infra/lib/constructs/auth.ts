import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';
import { AuthConfig } from '../config/auth-config';

export interface AuthConstructProps {
  authConfig: AuthConfig;
  /** Full resource name for the User Pool, e.g. 'playx-dev-users'. */
  userPoolName: string;
  /** Full resource name for the app client, e.g. 'playx-dev-web-client'. */
  webClientName: string;
  /** Full resource name for the DefineAuthChallenge trigger, e.g. 'playx-dev-auth-define-challenge'. */
  defineAuthChallengeFunctionName: string;
  /** Full resource name for the CreateAuthChallenge trigger, e.g. 'playx-dev-auth-create-challenge'. */
  createAuthChallengeFunctionName: string;
  /** Full resource name for the VerifyAuthChallengeResponse trigger, e.g. 'playx-dev-auth-verify-challenge'. */
  verifyAuthChallengeFunctionName: string;
}

/**
 * Story 2.4 customer identity: one Cognito User Pool for Play X customers, plus a single
 * public (secret-less) app client for the marketing site's future signup/login flow.
 *
 * Deliberately minimal: no Hosted UI domain, no OAuth app integration, no Identity Pool
 * (federated/IAM credentials) — none of that is needed until a frontend actually calls this
 * pool, which this story doesn't do (see CLAUDE.md / js/auth.js, still Firebase-backed today).
 *
 * Guest-first passwordless auth adds a Cognito CUSTOM_AUTH challenge — three Lambda triggers
 * (DefineAuthChallenge/CreateAuthChallenge/VerifyAuthChallengeResponse, see
 * backend/src/handlers/auth-define-challenge.ts and its neighbors) wired via `lambdaTriggers`
 * below. This exists instead of Cognito's native EMAIL_OTP first factor because EMAIL_OTP
 * generates eight-digit codes that Play X can't reconfigure, and the product requirement is
 * every OTP being exactly six digits (see backend/src/lib/otp.ts). These triggers are invoked by
 * Cognito directly, never through API Gateway — see constructs/api.ts for the public
 * POST /auth/start and POST /auth/verify routes that drive them via AdminInitiateAuth/
 * AdminRespondToAuthChallenge.
 */
export class AuthConstruct extends Construct {
  public readonly userPool: cognito.UserPool;
  public readonly webClient: cognito.UserPoolClient;
  /** Phase 3B: the "admin" Cognito group — see this class's constructor for what it's for. */
  public readonly adminGroup: cognito.CfnUserPoolGroup;

  constructor(scope: Construct, id: string, props: AuthConstructProps) {
    super(scope, id);

    const { authConfig } = props;

    // Not VPC-attached, same as the auth-start/auth-verify API Lambdas (see constructs/api.ts):
    // DefineAuthChallenge/VerifyAuthChallengeResponse call no AWS APIs at all (pure functions of
    // the event Cognito hands them), and CreateAuthChallenge only calls SES, never the database.
    const triggerFunctionDefaults = {
      depsLockFilePath: path.join(__dirname, '../../../backend/package-lock.json'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      bundling: {
        externalModules: ['@aws-sdk/*'],
      },
    };

    const defineAuthChallengeFunction = new lambdaNodejs.NodejsFunction(this, 'DefineAuthChallengeFunction', {
      ...triggerFunctionDefaults,
      functionName: props.defineAuthChallengeFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/auth-define-challenge.ts'),
    });

    const createAuthChallengeFunction = new lambdaNodejs.NodejsFunction(this, 'CreateAuthChallengeFunction', {
      ...triggerFunctionDefaults,
      functionName: props.createAuthChallengeFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/auth-create-challenge.ts'),
      environment: {
        SES_FROM_EMAIL: authConfig.sesFromEmail,
        SES_FROM_NAME: authConfig.sesFromName,
        SES_REGION: authConfig.sesRegion,
      },
    });

    const verifyAuthChallengeFunction = new lambdaNodejs.NodejsFunction(this, 'VerifyAuthChallengeFunction', {
      ...triggerFunctionDefaults,
      functionName: props.verifyAuthChallengeFunctionName,
      entry: path.join(__dirname, '../../../backend/src/handlers/auth-verify-challenge.ts'),
    });

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

      // Explicit rather than relying on the "ESSENTIALS for a newly created pool" default —
      // this pool already exists at ESSENTIALS in live AWS; pin it rather than inherit a default
      // that could silently change under us.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,

      // Play X is fully passwordless from launch (no production users to keep backward
      // compatible — see the architecture decision this implements). `emailOtp: true` is what
      // lets AdminCreateUser (auth-start.ts) create a brand-new customer with NO
      // TemporaryPassword at all: per AWS's AdminCreateUser docs, omitting TemporaryPassword
      // only skips Cognito auto-generating one for you "unless you have passwordless options
      // active for your user pool" — i.e. this signInPolicy flag is what that provisioning
      // behavior is actually gated on, not just a login-time nicety.
      //
      // `password: true` stays alongside it, but NOT by choice: CDK's UserPool L2 construct
      // hard-fails synthesis ("The password authentication cannot be disabled") if
      // allowedFirstAuthFactors.password is ever set to false — see configureSignInPolicy in
      // aws-cdk-lib/aws-cognito/lib/user-pool.js. This is a CDK-level guard, not something this
      // stack can route around short of an unverified CfnUserPool property override, so PASSWORD
      // stays structurally present in this list. It's dead in practice, though: no WebClient
      // authFlow below reaches it (no ALLOW_USER_SRP_AUTH, ALLOW_USER_PASSWORD_AUTH, or
      // ALLOW_USER_AUTH — CUSTOM_AUTH is the only thing this app client can do), and this
      // signInPolicy only governs USER_AUTH's choice-based first factor plus AdminCreateUser's
      // passwordless provisioning — neither of which a caller can use to actually authenticate
      // with a password. Also NOT reintroducing native EMAIL_OTP as a reachable login path: the
      // WebClient has no `user: true` (ALLOW_USER_AUTH), so nothing can pick this first factor
      // directly and bypass auth-start.ts's own six-digit OTP for Cognito's native eight-digit
      // one — see backend/src/lib/otp.ts.
      signInPolicy: {
        allowedFirstAuthFactors: {
          password: true,
          emailOtp: true,
        },
      },

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

      // Wires up the three CUSTOM_AUTH triggers created above. This updates the existing User
      // Pool's LambdaConfig in place (CDK diffs this as an update, not a replacement) — it does
      // not create a new pool, and every existing user/credential is untouched. CDK's UserPool
      // construct also grants each function's `cognito-idp.amazonaws.com` invoke permission
      // automatically as part of wiring this up (see addLambdaPermission internally) — no
      // separate iam.PolicyStatement needed for that direction.
      lambdaTriggers: {
        defineAuthChallenge: defineAuthChallengeFunction,
        createAuthChallenge: createAuthChallengeFunction,
        verifyAuthChallengeResponse: verifyAuthChallengeFunction,
      },

      deletionProtection: authConfig.deletionProtection,
      removalPolicy: authConfig.removalPolicy,
    });

    this.webClient = new cognito.UserPoolClient(this, 'WebClient', {
      userPool: this.userPool,
      userPoolClientName: props.webClientName,

      // A secret embedded in browser JS isn't a secret — mandatory false for a public client.
      generateSecret: false,

      // Play X is fully passwordless from launch: `custom: true` is ALLOW_CUSTOM_AUTH, required
      // for AdminInitiateAuth's CUSTOM_AUTH flow (see auth-start.ts) — Cognito rejects that
      // AuthFlow otherwise, and it's the only sign-in path this client offers. Deliberately NOT
      // `userSrp`/ALLOW_USER_SRP_AUTH (SRP is still password-based — it just avoids sending the
      // password itself over the wire) and NOT `user`/ALLOW_USER_AUTH (Cognito's choice-based
      // flow, which would let a caller pick PASSWORD or EMAIL_OTP directly as a first factor,
      // bypassing auth-start.ts's own six-digit OTP for Cognito's uncontrollable eight-digit one
      // — see backend/src/lib/otp.ts). Also no `userPassword`/`adminUserPassword`
      // (ALLOW_USER_PASSWORD_AUTH/ALLOW_ADMIN_USER_PASSWORD_AUTH) — never enabled here, so no
      // password auth flow of any kind is reachable through this client, matching the "no
      // customer passwords, no password login" architecture decision even though
      // signInPolicy.allowedFirstAuthFactors.password stays structurally true above (a CDK
      // constraint, not a reachable flow). ALLOW_REFRESH_TOKEN_AUTH is added automatically by
      // CDK whenever any authFlows are set, so it's preserved without being listed explicitly.
      authFlows: { custom: true },

      // Bounds how long a captured/leaked CUSTOM_AUTH Session value from /auth/start could be
      // replayed against, independent of auth-define-challenge.ts's own failed-attempt limit.
      // 3 minutes (the minimum Cognito allows, 3-15) is already this property's default —
      // pinned explicitly here (same rationale as featurePlan above) rather than left implicit.
      authSessionValidity: cdk.Duration.minutes(3),

      // Don't let a failed sign-in or forgot-password call reveal whether an email is
      // registered.
      preventUserExistenceErrors: true,
    });

    // Minimum SES permission to email the OTP. Resource-scoping this to the sender identity's
    // own ARN (arn:aws:ses:...:identity/playxcafesupport@gmail.com) turns out to reject the
    // SendEmail call itself — SES authorizes SendEmail/SendRawEmail against the *recipient*
    // identity, not the sender's, so a resource scoped to our own verified sender ARN can never
    // match an arbitrary customer's inbox and every send gets AccessDenied. Recipients must stay
    // arbitrary (any Play X customer's address, sandbox or post-production-access), so the
    // resource has to be "*"; the sender stays locked down instead via the ses:FromAddress
    // condition key, which SES checks against the address in SendEmailCommand's `Source` field
    // (lib/ses.ts) regardless of the display name prefix — so this Lambda can only ever send
    // "from" the one already-verified identity, to anyone.
    createAuthChallengeFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'ses:FromAddress': authConfig.sesFromEmail,
          },
        },
      }),
    );

    // Phase 3B: PLAY X ADMIN authorization reuses this same User Pool — no second User Pool, no
    // second auth system (see this phase's brief, item 1). "admin" is a plain Cognito group, not a
    // second app client or a different sign-in flow: an admin signs in through the exact same
    // passwordless CUSTOM_AUTH flow (auth-start.ts/auth-verify.ts) a customer does, and the only
    // thing that changes is whether their JWT's cognito:groups claim contains "admin" once they're
    // added to this group — checked entirely on the backend (see backend/src/lib/admin-auth.ts's
    // requireAdmin()), never assumed from anything the frontend sends. Group membership itself is
    // managed out-of-band (e.g. AdminAddUserToGroup via the AWS CLI/Console) — there is no
    // self-service "become an admin" signup path anywhere in this app, by design.
    this.adminGroup = new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'admin',
      description: 'Play X Admin — grants access to the /admin/* backend APIs.',
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
