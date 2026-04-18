/**
 * Alerts API — stores cry/noise alerts from monitor devices and
 * returns them to parent devices.
 *
 * Routes:
 *   POST /api/alerts         — create alert (from monitor)
 *   GET  /api/alerts         — get alerts for a room
 *   PUT  /api/alerts/:id     — resolve an alert
 *   DELETE /api/alerts       — clear all alerts for a room
 */

const express      = require('express');
const { verifyToken } = require('../middleware/auth');
const { getDb }    = require('../db');
const logger       = require('../utils/logger');

const router = express.Router();

// ── POST /api/alerts — create a new alert ─────────────────────────────────────
router.post('/', verifyToken, async (req, res) => {
  const { roomId, type = 'cry', intensity, soundLevel } = req.body;
  const uid = req.firebaseUser.uid;

  if (!roomId || !intensity) {
    return res.status(400).json({ error: 'roomId and intensity are required' });
  }

  try {
    const db = getDb();
    const result = await db.query(
      `INSERT INTO alerts (room_id, uid, type, intensity, sound_level)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [roomId, uid, type, intensity, soundLevel || null]
    );
    const alert = result.rows[0];
    logger.info('alerts.create', { roomId, type, intensity, uid });

    // Broadcast to any Socket.io clients in the room via the io instance
    const io = req.app.get('io');
    if (io) {
      io.to(roomId).emit('alert', alert);
    }

    res.status(201).json(alert);
  } catch (err) {
    logger.error('alerts.create error', err);
    res.status(500).json({ error: 'Failed to create alert' });
  }
});

// ── GET /api/alerts?roomId=xxx&limit=50 — fetch alerts ───────────────────────
router.get('/', verifyToken, async (req, res) => {
  const { roomId, limit = 50 } = req.query;
  if (!roomId) return res.status(400).json({ error: 'roomId is required' });

  try {
    const db = getDb();
    const result = await db.query(
      `SELECT * FROM alerts
       WHERE room_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [roomId, Math.min(parseInt(limit, 10) || 50, 200)]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('alerts.get error', err);
    res.status(500).json({ error: 'Failed to fetch alerts' });
  }
});

// ── PUT /api/alerts/:id — resolve an alert ────────────────────────────────────
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const db = getDb();
    const result = await db.query(
      `UPDATE alerts SET resolved = TRUE WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Alert not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('alerts.resolve error', err);
    res.status(500).json({ error: 'Failed to resolve alert' });
  }
});

// ── DELETE /api/alerts?roomId=xxx — clear all alerts for a room ───────────────
router.delete('/', verifyToken, async (req, res) => {
  const { roomId } = req.query;
  if (!roomId) return res.status(400).json({ error: 'roomId is required' });

  try {
    const db = getDb();
    await db.query('DELETE FROM alerts WHERE room_id = $1', [roomId]);
    res.json({ success: true });
  } catch (err) {
    logger.error('alerts.clear error', err);
    res.status(500).json({ error: 'Failed to clear alerts' });
  }
});

module.exports = router;
