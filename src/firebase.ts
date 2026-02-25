import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

let app: any = null;
let auth: any = null;
let db: any = null;
let isFirebaseConfigured = false;

if (typeof window !== 'undefined') {
    const savedConfig = localStorage.getItem('btc_firebase_cfg');
    if (savedConfig) {
        try {
            const config = JSON.parse(savedConfig);
            if (getApps().length === 0) app = initializeApp(config);
            else app = getApp();
            auth = getAuth(app);
            db = getFirestore(app);
            isFirebaseConfigured = true;
        } catch (e) {
            localStorage.removeItem('btc_firebase_cfg');
        }
    }
}

export { auth, db, isFirebaseConfigured };
