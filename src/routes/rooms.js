const express = require('express');
const { verifyToken } = require('../middleware/auth');
const logger  = require('../utils/logger');

const router = express.Router();

// In-memory room registry (backed by signaling server state)
// For a production system this would be in Redis/DB, but works fine for now.
const rooms = new Map();

router.post('/', verifyToken, (req, res) => {
  const { roomId } = req.body;
  if (!roomId) return res.status(400).json({ error: 'roomId required' });
  if (!rooms.has(roomId)) rooms.set(roomId, { roomId, ownerId: req.firebaseUser.uid, createdAt: new Date().toISOString() });
  logger.info('rooms.create', { roomId, uid: req.firebaseUser.uid });
  res.json(rooms.get(roomId));
});

router.get('/:roomId', verifyToken, (req, res) => {
  const room = rooms.get(req.params.roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json(room);
});

router.delete('/:roomId', verifyToken, (req, res) => {
  rooms.delete(req.params.roomId);
  res.json({ success: true });
});

module.exports = router;
