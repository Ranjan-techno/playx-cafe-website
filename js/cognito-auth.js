// Thin wrapper around amazon-cognito-identity-js, giving every other script
// (js/auth.js, js/site-auth-state.js, js/script.js, js/my-bookings.js) one
// small promise-based API instead of that library's callback style, and one
// place that knows about the Cognito User Pool itself.
//
// Requires js/aws-config.js to be loaded first (for AWS_CONFIG/isAwsConfigured)
// and the amazon-cognito-identity-js UMD bundle loaded before this file - see
// the <script> tags near the bottom of index.html/auth.html. Every function
// below is a no-op-safe no when isAwsConfigured is false (mirrors
// js/firebase-config.js's isFirebaseConfigured pattern) so callers only need
// to check CognitoAuth.isConfigured once, not before every call.
//
// Persistent auth state: CognitoUserPool stores tokens in window.localStorage
// by default (amazon-cognito-identity-js's own behavior, not configured
// here), and getSession() below transparently refreshes an expired access/ID
// token using the stored refresh token. That combination is what makes a
// signed-in visitor stay signed in across page loads and browser restarts
// with no extra code here.

const userPool = isAwsConfigured
  ? new AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: AWS_CONFIG.userPoolId,
      ClientId: AWS_CONFIG.userPoolClientId
    })
  : null;

function cognitoUserFor(email) {
  return new AmazonCognitoIdentity.CognitoUser({ Username: email, Pool: userPool });
}

// Cognito's `phone_number` attribute requires strict E.164 (+<country
// code><number>, digits only) - Play X's signup form (auth.html) only ever
// collects a bare Indian mobile number, so this is deliberately narrow
// (10 digits, optionally with a leading 0 or the 91 country code already on
// it) rather than a general-purpose phone parser. Returns null for anything
// that doesn't match one of those shapes, rather than guessing.
function normalizeIndianMobileToE164(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (/^\d{10}$/.test(digits)) return `+91${digits}`;
  if (/^0\d{10}$/.test(digits)) return `+91${digits.slice(1)}`;
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  return null;
}

function signUp(name, email, password, phone) {
  return new Promise((resolve, reject) => {
    const attributes = [new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'name', Value: name })];
    // The phoneNumber attribute isn't required (infra/lib/constructs/auth.ts)
    // and the signup form's phone field is optional to send on - but if one
    // was entered, normalize it to E.164 first (see above) rather than
    // sending the raw "6383599120" a customer types, which Cognito's
    // phone_number format validation would reject outright.
    if (phone) {
      const e164Phone = normalizeIndianMobileToE164(phone);
      if (!e164Phone) {
        reject({ code: 'InvalidPhoneNumberException', message: 'Enter a valid 10-digit Indian mobile number.' });
        return;
      }
      attributes.push(new AmazonCognitoIdentity.CognitoUserAttribute({ Name: 'phone_number', Value: e164Phone }));
    }
    userPool.signUp(email, password, attributes, null, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function confirmSignUp(email, code) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).confirmRegistration(code, true, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function resendConfirmationCode(email) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).resendConfirmationCode((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function signIn(email, password) {
  return new Promise((resolve, reject) => {
    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({ Username: email, Password: password });
    cognitoUserFor(email).authenticateUser(authDetails, {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err)
    });
  });
}

function signOut() {
  const user = userPool && userPool.getCurrentUser();
  if (user) user.signOut();
}

function forgotPassword(email) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).forgotPassword({
      onSuccess: (data) => resolve(data),
      onFailure: (err) => reject(err)
    });
  });
}

function confirmPassword(email, code, newPassword) {
  return new Promise((resolve, reject) => {
    cognitoUserFor(email).confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err)
    });
  });
}

/** Resolves the current, valid session (refreshing expired tokens against the
 *  stored refresh token first), or null if nobody is signed in / the refresh
 *  token itself is gone or revoked. Never rejects - a session lookup failing
 *  is treated as "signed out", not an error the caller needs to handle. */
function getSession() {
  return new Promise((resolve) => {
    const user = userPool && userPool.getCurrentUser();
    if (!user) {
      resolve(null);
      return;
    }
    user.getSession((err, session) => {
      if (err || !session || !session.isValid()) resolve(null);
      else resolve(session);
    });
  });
}

async function isLoggedIn() {
  return (await getSession()) !== null;
}

/** The Cognito access token JWT, or null if signed out. This is what
 *  Authorization: Bearer <token> carries to the API (see js/script.js /
 *  js/my-bookings.js) - the HTTP API's Cognito JWT authorizer
 *  (infra/lib/constructs/api.ts) accepts it via the token's `client_id`
 *  claim. */
async function getAccessToken() {
  const session = await getSession();
  return session ? session.getAccessToken().getJwtToken() : null;
}

/** Decoded ID token claims (name, email, ...) for prefilling UI - never used
 *  for anything security-sensitive; the API only ever trusts the "sub" claim
 *  it verifies itself from the access token. */
async function getIdTokenClaims() {
  const session = await getSession();
  return session ? session.getIdToken().decodePayload() : null;
}

const CognitoAuth = {
  isConfigured: isAwsConfigured,
  signUp,
  confirmSignUp,
  resendConfirmationCode,
  signIn,
  signOut,
  forgotPassword,
  confirmPassword,
  getSession,
  isLoggedIn,
  getAccessToken,
  getIdTokenClaims,
  normalizeIndianMobileToE164
};
