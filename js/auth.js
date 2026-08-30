// Auth page (Log In / Sign Up) - backed by Amazon Cognito via js/cognito-auth.js.
// Requires js/aws-config.js to be filled in with a real deployed User Pool
// (see that file for where the values come from). Until then, every action
// below shows a clear "not configured yet" message instead of failing
// silently - same degrade-gracefully pattern this page used with Firebase.

const tabLogin = document.getElementById('tabLogin');
const tabSignup = document.getElementById('tabSignup');
const viewLogin = document.getElementById('viewLogin');
const viewSignup = document.getElementById('viewSignup');
const viewVerify = document.getElementById('viewVerify');
const viewReset = document.getElementById('viewReset');
const authFormArea = document.getElementById('authFormArea');
const authSuccess = document.getElementById('authSuccess');
const successHeadline = document.getElementById('successHeadline');
const successMessage = document.getElementById('successMessage');
const loginStatus = document.getElementById('loginStatus');
const signupStatus = document.getElementById('signupStatus');
const verifyStatus = document.getElementById('verifyStatus');
const resetStatus = document.getElementById('resetStatus');

// The email a verify/reset panel is currently acting on - set whenever we
// switch into one of those views, read by their form submit handlers below.
let pendingEmail = '';

const ALL_VIEWS = { login: viewLogin, signup: viewSignup, verify: viewVerify, reset: viewReset };

function showAuthView(view) {
  Object.entries(ALL_VIEWS).forEach(([name, el]) => { el.hidden = name !== view; });
  const isLogin = view === 'login';
  const isSignup = view === 'signup';
  tabLogin.classList.toggle('active', isLogin);
  tabSignup.classList.toggle('active', isSignup);
  tabLogin.setAttribute('aria-selected', String(isLogin));
  tabSignup.setAttribute('aria-selected', String(isSignup));
}

// Open on whichever mode the link pointed to (?mode=login / ?mode=signup)
const initialMode = new URLSearchParams(location.search).get('mode') === 'signup' ? 'signup' : 'login';
showAuthView(initialMode);

tabLogin.addEventListener('click', () => showAuthView('login'));
tabSignup.addEventListener('click', () => showAuthView('signup'));
document.getElementById('goToSignup').addEventListener('click', () => showAuthView('signup'));
document.getElementById('goToLogin').addEventListener('click', () => showAuthView('login'));
document.getElementById('verifyBackToLogin').addEventListener('click', () => showAuthView('login'));
document.getElementById('resetBackToLogin').addEventListener('click', () => showAuthView('login'));

function showSuccess(headline, message, { redirect = true } = {}) {
  authFormArea.hidden = true;
  successHeadline.textContent = headline;
  successMessage.textContent = message;
  authSuccess.hidden = false;
  authSuccess.focus?.();
  if (redirect) {
    // A booking form submission that required login (js/script.js) stashes
    // this before sending the visitor here, so a successful log in returns
    // them straight to the booking section instead of the plain homepage.
    const returnTo = sessionStorage.getItem('pxPostLoginRedirect');
    sessionStorage.removeItem('pxPostLoginRedirect');
    setTimeout(() => { location.href = returnTo || 'index.html'; }, 1400);
  }
}

function setButtonLoading(btn, loadingText) {
  btn.disabled = true;
  btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
  btn.textContent = loadingText;
}

function resetButton(btn) {
  btn.disabled = false;
  if (btn.dataset.originalText) btn.textContent = btn.dataset.originalText;
}

const NOT_CONFIGURED_MESSAGE = 'Sign-in isn\'t set up yet - add your Cognito User Pool details in js/aws-config.js.';

// Cognito's own exception names (err.code from amazon-cognito-identity-js),
// mapped to the same short, friendly-sentence style the Firebase version of
// this file used for its ERROR_MESSAGES.
const ERROR_MESSAGES = {
  UsernameExistsException: 'That email already has an account - try logging in instead.',
  InvalidParameterException: 'Please double-check the details you entered.',
  // Thrown by js/cognito-auth.js's signUp() itself, before Cognito is ever
  // called, when the phone field doesn't normalize to a valid Indian mobile
  // number (see normalizeIndianMobileToE164 there).
  InvalidPhoneNumberException: 'Please enter a valid 10-digit Indian mobile number.',
  InvalidPasswordException: 'Password doesn\'t meet the requirements: at least 8 characters, with an uppercase letter, a lowercase letter, and a number.',
  NotAuthorizedException: 'Incorrect email or password.',
  UserNotFoundException: 'No account found with that email.',
  UserNotConfirmedException: 'This account hasn\'t verified its email yet.',
  CodeMismatchException: 'That code doesn\'t match - double-check it and try again.',
  ExpiredCodeException: 'That code has expired - request a new one.',
  LimitExceededException: 'Too many attempts - please wait a bit and try again.',
  TooManyRequestsException: 'Too many attempts - please wait a bit and try again.',
  TooManyFailedAttemptsException: 'Too many failed attempts - please wait a bit and try again.'
};

function friendlyError(error) {
  return ERROR_MESSAGES[error.code] || error.message || 'Something went wrong. Please try again.';
}

function showStatus(el, text) {
  el.textContent = text;
  el.classList.remove('success');
}

// Social auth buttons - the Cognito User Pool client is deliberately minimal
// (no Hosted UI domain, no OAuth app integration, no identity providers - see
// infra/lib/constructs/auth.ts), so Google/Apple sign-in isn't wired up to
// anything yet. The buttons stay in place rather than being removed, but they
// degrade to a clear message instead of pretending to work.
function handleSocialAuth(providerName, statusEl) {
  showStatus(statusEl, `${providerName} sign-in isn't available yet - please continue with email and password.`);
}

document.getElementById('googleLoginBtn').addEventListener('click', () => handleSocialAuth('Google', loginStatus));
document.getElementById('appleLoginBtn').addEventListener('click', () => handleSocialAuth('Apple', loginStatus));
document.getElementById('googleSignupBtn').addEventListener('click', () => handleSocialAuth('Google', signupStatus));
document.getElementById('appleSignupBtn').addEventListener('click', () => handleSocialAuth('Apple', signupStatus));

// Forgot password - switches to the reset panel and prefills whatever email
// was already typed into the login form, if any.
document.getElementById('forgotPasswordLink').addEventListener('click', (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value.trim();
  document.getElementById('resetEmail').value = email;
  document.getElementById('resetCodeFields').hidden = true;
  resetStatus.textContent = '';
  showAuthView('reset');
});

document.getElementById('sendResetCodeBtn').addEventListener('click', async (e) => {
  if (!CognitoAuth.isConfigured) {
    showStatus(resetStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const email = document.getElementById('resetEmail').value.trim();
  if (!email) {
    showStatus(resetStatus, 'Enter your email above first.');
    return;
  }
  const btn = e.currentTarget;
  setButtonLoading(btn, 'Sending...');
  try {
    await CognitoAuth.forgotPassword(email);
    pendingEmail = email;
    document.getElementById('resetCodeFields').hidden = false;
    document.getElementById('resetCode').required = true;
    document.getElementById('resetNewPassword').required = true;
    document.getElementById('resetConfirmPassword').required = true;
    showStatus(resetStatus, `Reset code sent to ${email}. Enter it below with your new password.`);
  } catch (err) {
    showStatus(resetStatus, friendlyError(err));
  } finally {
    resetButton(btn);
  }
});

document.getElementById('resetForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!CognitoAuth.isConfigured) {
    showStatus(resetStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const code = document.getElementById('resetCode').value.trim();
  const newPassword = document.getElementById('resetNewPassword').value;
  const confirmPassword = document.getElementById('resetConfirmPassword').value;
  if (newPassword !== confirmPassword) {
    showStatus(resetStatus, 'Passwords do not match.');
    return;
  }
  const btn = document.getElementById('resetSubmitBtn');
  setButtonLoading(btn, 'Resetting...');
  try {
    await CognitoAuth.confirmPassword(pendingEmail || document.getElementById('resetEmail').value.trim(), code, newPassword);
    showStatus(resetStatus, 'Password reset! You can now log in with your new password.');
    resetStatus.classList.add('success');
    document.getElementById('loginEmail').value = pendingEmail;
    setTimeout(() => showAuthView('login'), 1200);
  } catch (err) {
    showStatus(resetStatus, friendlyError(err));
  } finally {
    resetButton(btn);
  }
});

// Email verification
function goToVerify(email, message) {
  pendingEmail = email;
  document.getElementById('verifyEmailLabel').textContent = email;
  verifyStatus.textContent = message || '';
  verifyStatus.classList.remove('success');
  showAuthView('verify');
}

document.getElementById('verifyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!CognitoAuth.isConfigured) {
    showStatus(verifyStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const code = document.getElementById('verifyCode').value.trim();
  const btn = document.getElementById('verifySubmitBtn');
  setButtonLoading(btn, 'Verifying...');
  try {
    await CognitoAuth.confirmSignUp(pendingEmail, code);
    document.getElementById('loginEmail').value = pendingEmail;
    showStatus(verifyStatus, 'Email verified! You can now log in.');
    verifyStatus.classList.add('success');
    setTimeout(() => showAuthView('login'), 1200);
  } catch (err) {
    showStatus(verifyStatus, friendlyError(err));
  } finally {
    resetButton(btn);
  }
});

document.getElementById('resendCodeBtn').addEventListener('click', async () => {
  if (!CognitoAuth.isConfigured || !pendingEmail) return;
  try {
    await CognitoAuth.resendConfirmationCode(pendingEmail);
    showStatus(verifyStatus, `A new code was sent to ${pendingEmail}.`);
  } catch (err) {
    showStatus(verifyStatus, friendlyError(err));
  }
});

// Log in form
const loginForm = document.getElementById('loginForm');
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!CognitoAuth.isConfigured) {
    showStatus(loginStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  const btn = document.getElementById('loginSubmitBtn');
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  setButtonLoading(btn, 'Logging in...');
  try {
    await CognitoAuth.signIn(email, password);
    showSuccess('Welcome back!', `Logged in as ${email}.`);
  } catch (err) {
    resetButton(btn);
    if (err.code === 'UserNotConfirmedException') {
      goToVerify(email, 'Please verify your email before logging in - enter the code we emailed you, or resend one below.');
      return;
    }
    showStatus(loginStatus, friendlyError(err));
  }
});

// Sign up form
const signupForm = document.getElementById('signupForm');
signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!CognitoAuth.isConfigured) {
    showStatus(signupStatus, NOT_CONFIGURED_MESSAGE);
    return;
  }
  if (signupForm.password.value !== signupForm.confirm.value) {
    showStatus(signupStatus, 'Passwords do not match.');
    return;
  }

  const name = signupForm.name.value.trim();
  const email = signupForm.email.value.trim();
  const password = signupForm.password.value;
  // Sent to Cognito exactly as typed (e.g. "6383599120") - js/cognito-auth.js's
  // signUp() normalizes it to E.164 ("+916383599120") before it reaches
  // Cognito. The input's displayed value is never rewritten.
  const phone = signupForm.phone.value.trim();
  const btn = document.getElementById('signupSubmitBtn');

  setButtonLoading(btn, 'Creating account...');
  try {
    await CognitoAuth.signUp(name, email, password, phone);
    goToVerify(email, `We sent a verification code to ${email}. Enter it below to activate your account.`);
  } catch (err) {
    resetButton(btn);
    showStatus(signupStatus, friendlyError(err));
  }
});

// Persistent auth state: if a valid session already exists (page reload,
// coming back later), skip the forms entirely.
if (CognitoAuth.isConfigured) {
  CognitoAuth.getSession().then((session) => {
    if (session && authFormArea && !authFormArea.hidden) {
      CognitoAuth.getIdTokenClaims().then((claims) => {
        const label = claims?.name || claims?.email || 'Racer';
        showSuccess('You\'re already logged in', `Signed in as ${label}.`, { redirect: false });
      });
    }
  });
} else {
  showStatus(loginStatus, NOT_CONFIGURED_MESSAGE);
  showStatus(signupStatus, NOT_CONFIGURED_MESSAGE);
}
