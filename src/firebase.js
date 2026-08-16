import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

// ============================================================
// PASTE YOUR FIREBASE PROJECT CONFIG HERE
// (Firebase console > Project settings > General > Your apps > SDK setup and config)
// This is safe to commit / expose publicly — it's a client identifier,
// not a secret. Access is controlled by your Realtime Database rules.
// ============================================================
const firebaseConfig = {
  apiKey: "AIzaSyBEG-9SavAtpFIqFLpM5ttUr6EVtk8UEqs",
  authDomain: "texas-chili-sot.firebaseapp.com",
  databaseURL: "https://texas-chili-sot-default-rtdb.firebaseio.com",
  projectId: "texas-chili-sot",
  storageBucket: "texas-chili-sot.firebasestorage.app",
  messagingSenderId: "56562369853",
  appId: "1:56562369853:web:31c53473edec838ffc7154",
};

const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
