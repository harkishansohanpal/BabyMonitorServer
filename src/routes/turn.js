/**
 * TURN credentials endpoint.
 * Calls the Cloudflare Realtime API to generate short-lived TURN credentials
 * and returns them as an ICE server config object ready for RTCPeerConnection.
 *
 * GET /api/turn  →  { urls: [...], username: "...", credential: "..." }
 */

const express        = require('express');
const { verifyToken } = require('../middleware/auth');
const logger         = require('../utils/logger');

const router = express.Router();

router.get('/', verifyToken, async (req, res) => {
  const keyId    = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    logger.warn('TURN: CF_TURN_KEY_ID or CF_TURN_API_TOKEN not set');
    return res.status(503).json({ error: 'TURN not configured' });
  }

  try {
    const cfRes = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }), // 24-hour credentials
      }
    );

    if (!cfRes.ok) {
      const text = await cfRes.text();
      logger.error('Cloudflare TURN error', { status: cfRes.status, text });
      return res.status(502).json({ error: 'Cloudflare TURN request failed' });
    }

    const { iceServers } = await cfRes.json();
    logger.debug('TURN credentials generated');
    res.json(iceServers); // { urls: [...], username, credential }
  } catch (err) {
    logger.error('TURN credentials fetch error', err);
    res.status(500).json({ error: 'Failed to generate TURN credentials' });
  }
});

module.exports = router;
