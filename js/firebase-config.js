// ============================================================
//  DENTAL NURSE REVISION — Firebase Configuration
// ============================================================
//  SETUP INSTRUCTIONS:
//  1. Go to https://console.firebase.google.com
//  2. Create a new project (or use an existing one)
//  3. Add a Web App to the project
//  4. Copy the firebaseConfig values below from your app settings
//  5. In Firebase Console:
//       - Enable Authentication → Email/Password
//       - Create Firestore Database (start in production mode)
//  6. Deploy the rules in firestore.rules
// ============================================================

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

// ⚠️  REPLACE THESE VALUES WITH YOUR OWN FIREBASE CONFIG
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  storageBucket:     "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId:             "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);

export const db   = getFirestore(app);
export const auth = getAuth(app);
export { app };
