import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import * as FirebaseAuth from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { getFirestore, initializeFirestore, type Firestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || process.env.EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

let app: FirebaseApp;
if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
} else {
  app = getApps()[0];
}

let auth: FirebaseAuth.Auth;
try {
  if (Platform.OS === 'web') {
    auth = FirebaseAuth.getAuth(app);
  } else {
    const getPersistence = (FirebaseAuth as any).getReactNativePersistence;
    if (typeof getPersistence === 'function') {
      auth = FirebaseAuth.initializeAuth(app, {
        persistence: getPersistence(AsyncStorage),
      });
    } else {
      auth = FirebaseAuth.getAuth(app);
    }
  }
} catch {
  auth = FirebaseAuth.getAuth(app);
}

let db: Firestore;
try {
  db = initializeFirestore(app, {
    experimentalForceLongPolling: true,
  });
} catch {
  db = getFirestore(app);
}
const googleProvider = new FirebaseAuth.GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export { app, auth, db, googleProvider };

