const admin  = require('firebase-admin');
const logger = require('./logger');

let initialized = false;

function initFirebase() {
  if (initialized) return;
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
    initialized = true;
    logger.info('Firebase Admin SDK initialised');
  } catch (err) {
    logger.error('Firebase Admin SDK init failed', err);
    throw err;
  }
}

async function verifyIdToken(idToken) {
  return admin.auth().verifyIdToken(idToken);
}

module.exports = { initFirebase, verifyIdToken };
