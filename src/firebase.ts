import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { DEFAULT_FIREBASE_CONFIG } from './config';

let app: any = null;
let auth: any = null;
let db: any = null;
let isFirebaseConfigured = false;

if (typeof window !== 'undefined') {
    const savedConfig = localStorage.getItem('btc_firebase_cfg');
    let config = null;

    if (savedConfig) {
        try {
            config = JSON.parse(savedConfig);
        } catch (e) {
            localStorage.removeItem('btc_firebase_cfg');
        }
    }

    // Use default if no custom config is found
    if (!config) config = DEFAULT_FIREBASE_CONFIG;

    if (config) {
        try {
            if (getApps().length === 0) app = initializeApp(config);
            else app = getApp();
            auth = getAuth(app);
            db = getFirestore(app);
            isFirebaseConfigured = true;
        } catch (e) {
            console.error("Firebase init error:", e);
        }
    }
}

export { auth, db, isFirebaseConfigured };
