import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

function normalizeEnvValue(value) {
  if (!value) {
    return value;
  }

  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizePrivateKey(value) {
  return normalizeEnvValue(value)?.replace(/\\n/g, '\n');
}

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const json = Buffer.from(normalizeEnvValue(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64), 'base64').toString('utf8');
    return JSON.parse(json);
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(normalizeEnvValue(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
  }

  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: normalizeEnvValue(process.env.FIREBASE_PROJECT_ID),
      clientEmail: normalizeEnvValue(process.env.FIREBASE_CLIENT_EMAIL),
      privateKey: normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
    };
  }

  return null;
}

function getFirebaseApp() {
  if (getApps().length) {
    return getApps()[0];
  }

  const serviceAccount = parseServiceAccount();

  if (!serviceAccount) {
    return null;
  }

  return initializeApp({
    credential: cert(serviceAccount),
  });
}

export function getFirebaseMessaging() {
  let app;

  try {
    app = getFirebaseApp();
  } catch (error) {
    console.warn('Firebase Admin initialization failed:', error.message);
    return null;
  }

  if (!app) {
    return null;
  }

  return getMessaging(app);
}
