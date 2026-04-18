const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { verifyToken } = require('../middleware/auth');
const { getDb }  = require('../db');
const logger     = require('../utils/logger');

const router = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, keyGenerator: req => `auth:${req.ip}` });

// POST /api/auth/verify — upsert user on login
router.post('/verify', authLimiter, verifyToken, async (req, res) => {
  const { uid, email, name: displayName, picture: photoUrl } = req.firebaseUser;
  try {
    const db = getDb();
    const result = await db.query(`
      INSERT INTO users (firebase_uid, email, display_name, photo_url, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (firebase_uid) DO UPDATE SET
        email        = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        photo_url    = EXCLUDED.photo_url,
        updated_at   = NOW()
      RETURNING id, firebase_uid, email, display_name, role, created_at
    `, [uid, email, displayName || email, photoUrl || null]);

    const user = result.rows[0];
    logger.info('auth.verify: user upserted', { uid, email });
    res.json({ uid: user.firebase_uid, email: user.email, displayName: user.display_name, role: user.role });
  } catch (err) {
    logger.error('auth.verify: DB error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/auth/me
router.get('/me', verifyToken, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      'SELECT firebase_uid, email, display_name, role, created_at FROM users WHERE firebase_uid = $1',
      [req.firebaseUser.uid]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    const u = result.rows[0];
    res.json({ uid: u.firebase_uid, email: u.email, displayName: u.display_name, role: u.role, createdAt: u.created_at });
  } catch (err) {
    logger.error('auth.me: DB error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/auth/logout
router.post('/logout', verifyToken, async (req, res) => {
  try {
    const db = getDb();
    await db.query('UPDATE users SET last_logout = NOW() WHERE firebase_uid = $1', [req.firebaseUser.uid]);
  } catch (_) {}
  res.json({ success: true });
});

module.exports = router;
