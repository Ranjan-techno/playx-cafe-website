// ============================================================================
// Firebase project keys - REQUIRED before sign-up / log-in will work for real.
//
// 1. Go to https://console.firebase.google.com and create a project (free).
// 2. In the project, click the "</>" (web app) icon to register a web app.
// 3. Firebase shows you a firebaseConfig object - copy those values in below.
// 4. In the left sidebar go to Build > Authentication > Get started, then on
//    the "Sign-in method" tab enable: Email/Password, and Google.
//    (Apple sign-in additionally needs a paid Apple Developer account -
//    see the note near the Apple button handler in auth.js.)
// 5. Still in Authentication > Settings > Authorized domains, add whatever
//    domain you deploy this site to (localhost is already allowed).
// ============================================================================

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const isFirebaseConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";

if (isFirebaseConfigured) {
  firebase.initializeApp(firebaseConfig);
}
