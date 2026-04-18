const { verifyIdToken } = require('../utils/firebase');
const logger = require('../utils/logger');

async function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    req.firebaseUser = await verifyIdToken(token);
    next();
  } catch (err) {
    logger.warn('Token verification failed', { error: err.message });
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { verifyToken };
