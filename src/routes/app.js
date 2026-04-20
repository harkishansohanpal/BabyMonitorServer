/**
 * /app/monitor  and  /app/viewer
 *
 * Serves WebRTC HTML pages over HTTPS so Android WebView treats them as a
 * "secure context" and allows getUserMedia() camera/microphone access.
 *
 * Credentials (token, roomId, signalingUrl) are injected by the React Native
 * app via WebView.injectedJavaScriptBeforeContentLoaded — the page reads them
 * from window.__RN_CFG__ which is set before any page scripts run.
 */

const express = require('express');
const router  = express.Router();

// ── Shared CSS ─────────────────────────────────────────────────────────────────
const BASE_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body {
    background:#000;
    width:100%; height:100%;
    overflow:hidden;
    font-family:-apple-system,'Segoe UI',Roboto,sans-serif;
  }
  body {
    display:flex; flex-direction:column;
    align-items:center; justify-content:center;
  }
  video {
    width:100vw;
    height:100vh;
    object-fit:cover;
    background:#111;
  }
  #overlay {
    position:fixed; bottom:0; left:0; right:0;
    padding:10px 16px 12px;
    background:linear-gradient(transparent,rgba(0,0,0,.75));
    display:flex; flex-direction:column; align-items:center; gap:2px;
  }
  #status { color:#fff; font-size:14px; text-align:center; font-weight:500; }
  #room   { color:rgba(255,255,255,.5); font-size:11px; }
  #error  { color:#ff6b6b; font-size:12px; text-align:center; margin-top:4px; }
`;

// ── Monitor HTML ───────────────────────────────────────────────────────────────
const MONITOR_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>
    ${BASE_CSS}
    video { transform:scaleX(-1); }
  </style>
</head>
<body>
  <video id="v" autoplay playsinline muted></video>
  <div id="overlay">
    <div id="status">Starting camera…</div>
    <div id="room"></div>
    <div id="error"></div>
  </div>

<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
(function () {
  var cfg    = window.__RN_CFG__ || {};
  var TOKEN  = cfg.token  || '';
  var ROOM   = cfg.roomId || '';
  var SIGURL = cfg.signalingUrl || '';

  var STATUS = document.getElementById('status');
  var ROOM_EL= document.getElementById('room');
  var ERROR  = document.getElementById('error');
  var video  = document.getElementById('v');
  ROOM_EL.textContent = 'Room: ' + ROOM;

  var ICE = cfg.iceServers
    ? { iceServers: cfg.iceServers }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  var pc = null;
  var socket;
  var localStream;

  function rn(msg) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(msg);
  }

  function createPC() {
    if (pc) { try { pc.close(); } catch(_) {} }
    pc = new RTCPeerConnection(ICE);
    if (localStream) {
      localStream.getTracks().forEach(function(t) { pc.addTrack(t, localStream); });
    }
    pc.onicecandidate = function(e) {
      if (e.candidate && socket && socket.connected) {
        socket.emit('ice-candidate', { candidate: e.candidate });
      }
    };
    pc.oniceconnectionstatechange = function() {
      if (pc.iceConnectionState === 'failed') { pc.restartIce && pc.restartIce(); }
    };
    return pc;
  }

  async function startCamera() {
    STATUS.textContent = 'Requesting camera…';
    var constraints = [
      { video: { facingMode: 'environment' }, audio: true },
      { video: true, audio: true },
    ];
    for (var i = 0; i < constraints.length; i++) {
      try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints[i]);
        video.srcObject = localStream;
        STATUS.textContent = 'Camera ready — connecting…';
        createPC();
        connectSocket();
        return;
      } catch (err) {
        if (i === constraints.length - 1) {
          ERROR.textContent = 'Camera error: ' + err.message;
          STATUS.textContent = 'Could not access camera';
          rn('error');
        }
      }
    }
  }

  function connectSocket() {
    socket = io(SIGURL, {
      auth: { token: TOKEN },
      transports: ['websocket'],
      reconnection: true,
    });

    socket.on('connect', function () {
      STATUS.textContent = 'Connected — waiting for viewer…';
      socket.emit('join', { roomId: ROOM, role: 'camera' });
      rn('socket-connected');
    });

    socket.on('peer-joined', function (data) {
      if (data.role === 'viewer') {
        STATUS.textContent = 'Viewer joined — setting up stream…';
        createPC();
        socket.emit('request-offer');
      }
    });

    socket.on('offer', async function (data) {
      try {
        await pc.setRemoteDescription(data.sdp);
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { sdp: { type: answer.type, sdp: answer.sdp } });
        STATUS.textContent = '✅ Streaming live';
        rn('streaming');
      } catch (err) {
        ERROR.textContent = 'Stream error: ' + err.message;
      }
    });

    socket.on('ice-candidate', async function (data) {
      if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch(_) {} }
    });

    socket.on('peer-disconnected', function () {
      STATUS.textContent = 'Viewer left — waiting…';
      rn('viewer-left');
    });

    socket.on('connect_error', function (err) {
      ERROR.textContent = 'Server error: ' + err.message;
    });
  }

  startCamera();
})();
</script>
</body>
</html>`;

// ── Viewer HTML ────────────────────────────────────────────────────────────────
const VIEWER_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
  <style>${BASE_CSS}</style>
</head>
<body>
  <video id="v" autoplay playsinline></video>
  <div id="overlay">
    <div id="status">Connecting to room…</div>
    <div id="room"></div>
    <div id="error"></div>
  </div>

<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
(function () {
  var cfg    = window.__RN_CFG__ || {};
  var TOKEN  = cfg.token  || '';
  var ROOM   = cfg.roomId || '';
  var SIGURL = cfg.signalingUrl || '';

  var STATUS = document.getElementById('status');
  var ROOM_EL= document.getElementById('room');
  var ERROR  = document.getElementById('error');
  var video  = document.getElementById('v');
  ROOM_EL.textContent = 'Room: ' + ROOM;

  var ICE_SERVERS = cfg.iceServers
    ? { iceServers: cfg.iceServers }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  var pc = null;

  function rn(msg) {
    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(msg);
  }

  function sanitizeSDP(sdpObj) {
    if (!sdpObj || !sdpObj.sdp) return sdpObj;
    var clean = sdpObj.sdp
      .split(/\\r?\\n/)
      .filter(function(l) { return l !== 'a=extmap-allow-mixed'; })
      .join('\\r\\n');
    return { type: sdpObj.type, sdp: clean };
  }

  function createPC() {
    if (pc) { try { pc.close(); } catch(_) {} }
    pc = new RTCPeerConnection(ICE_SERVERS);
    pc.ontrack = function(e) {
      if (e.streams && e.streams[0]) {
        video.srcObject = e.streams[0];
        STATUS.textContent = '✅ Live feed connected';
        ERROR.textContent = '';
        rn('connected');
      }
    };
    pc.oniceconnectionstatechange = function() {
      if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
        STATUS.textContent = '⚠️ Connection lost';
        rn('disconnected');
      }
    };
    pc.onicecandidate = function(e) {
      if (e.candidate && socket.connected) {
        socket.emit('ice-candidate', { candidate: e.candidate });
      }
    };
    return pc;
  }

  var socket = io(SIGURL, {
    auth: { token: TOKEN },
    transports: ['websocket'],
    reconnection: true,
  });

  socket.on('connect', function() {
    STATUS.textContent = 'Connected — joining room…';
    socket.emit('join', { roomId: ROOM, role: 'viewer' });
  });

  socket.on('waiting-for-camera', function() {
    STATUS.textContent = '⏳ Waiting for monitor to come online…';
    rn('waiting');
  });

  socket.on('peer-joined', function(data) {
    if (data.role === 'camera') {
      STATUS.textContent = 'Monitor online — waiting for stream…';
    }
  });

  socket.on('request-offer', async function() {
    STATUS.textContent = 'Setting up stream…';
    try {
      createPC();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { sdp: { type: offer.type, sdp: offer.sdp } });
    } catch(err) {
      ERROR.textContent = 'Setup error: ' + err.message;
      rn('disconnected');
    }
  });

  socket.on('answer', async function(data) {
    try {
      await pc.setRemoteDescription(sanitizeSDP(data.sdp));
    } catch(err) {
      ERROR.textContent = 'Connection error: ' + err.message;
      rn('disconnected');
    }
  });

  socket.on('ice-candidate', async function(data) {
    if (data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch(_) {} }
  });

  socket.on('peer-disconnected', function() {
    STATUS.textContent = '📷 Monitor stopped — waiting for reconnect…';
    video.srcObject = null;
    rn('disconnected');
  });

  socket.on('connect_error', function(err) {
    ERROR.textContent = 'Server error: ' + err.message;
  });
})();
</script>
</body>
</html>`;

// ── Routes (no auth — credentials are injected client-side) ───────────────────
router.get('/monitor', (_req, res) => res.type('html').send(MONITOR_HTML));
router.get('/viewer',  (_req, res) => res.type('html').send(VIEWER_HTML));

module.exports = router;
