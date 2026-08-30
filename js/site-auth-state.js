// Reflects Cognito login state in the site header: shows "My Account" (a
// link to the #my-bookings section below) + "Log Out" when signed in, or the
// default Log In / Sign Up links when signed out. Requires js/aws-config.js
// to be filled in - if it isn't, the header is left as-is (default Log In /
// Sign Up links), same degrade-gracefully pattern this used with Firebase.

if (CognitoAuth.isConfigured) {
  const authAreas = [
    document.getElementById('desktopAuthArea'),
    document.getElementById('mobileAuthArea')
  ].filter(Boolean);
  const defaultHTML = new Map(authAreas.map((el) => [el, el.innerHTML]));

  function renderLoggedIn() {
    authAreas.forEach((el) => {
      const btnSize = el.id === 'desktopAuthArea' ? 'btn btn-sm btn-text auth-btn-desktop' : 'btn btn-outline';
      const outBtnSize = el.id === 'desktopAuthArea' ? 'btn btn-sm btn-outline auth-btn-desktop' : 'btn btn-primary';
      el.innerHTML = `<a href="#my-bookings" class="${btnSize}">My Account</a><button type="button" class="${outBtnSize} logout-btn">Log Out</button>`;
      el.querySelector('.logout-btn').addEventListener('click', () => {
        CognitoAuth.signOut();
        // No auth-state listener exists for Cognito the way Firebase's
        // onAuthStateChanged provided one, so a full reload is the simplest
        // reliable way to put every piece of UI (header, booking gate, My
        // Bookings list) back into its signed-out state together.
        location.href = 'index.html';
      });
    });
  }

  function renderLoggedOut() {
    authAreas.forEach((el) => { el.innerHTML = defaultHTML.get(el); });
  }

  CognitoAuth.getSession().then((session) => {
    if (session) renderLoggedIn();
    else renderLoggedOut();
  });
}
