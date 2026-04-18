/**
 * Baby Monitor Server — Entry point
 * Express + Socket.io server for WebRTC signaling and REST API.
 */

const path = require('path');

// Load environment variables from .env file (local dev only — Render injects them directly)
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env';
require('dotenv').config({ path: path.resolve(__dirname, envFile) });

const http     = require('http');
const express  = require('express');
const helmet   = require('helmet');
const cors     = require('cors');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const logger          = require('./src/utils/logger');
const { initFirebase } = require('./src/utils/firebase');
const { initDb }      = require('./src/db');
const setupSignaling  = require('./src/signaling');
const authRoutes      = require('./src/routes/auth');
const roomRoutes      = require('./src/routes/rooms');

// ── Init ──────────────────────────────────────────────────────────────────────
initFirebase();
const db = initDb();

const app    = express();
const server = http.createServer(app);

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  credentials: true,
}));
app.use(express.json());

// Request ID
app.use((req, _res, next) => { req.id = uuidv4(); next(); });

// HTTP request logging
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const start = Date.now();
  res.on('finish', () => {
    logger.http(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - start}ms`, { reqId: req.id });
  });
  next();
});

// General rate limiter
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() });
});

app.use('/api/auth',  authRoutes);
app.use('/api/rooms', roomRoutes);

// 404 handler
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// Error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── WebRTC Signaling (Socket.io) ──────────────────────────────────────────────
setupSignaling(server);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Baby Monitor Server running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = (signal) => {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(() => {
    logger.info('HTTP server closed');
    db.end().then(() => process.exit(0)).catch(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 15000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  err => { logger.error('Uncaught exception', err); process.exit(1); });
process.on('unhandledRejection', err => { logger.error('Unhandled rejection', err); process.exit(1); });
