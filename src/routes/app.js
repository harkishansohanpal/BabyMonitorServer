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

<script src="https://webrtc.github.io/adapter/adapter-latest.js"></script>
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script>
// Config is delivered by React Native via injectJavaScript after page load
// (most reliable cross-platform). injectedJavaScriptBeforeContentLoaded also
// sets window.__RN_CFG__ as an early path for iOS. URL hash is a final fallback.
// The page waits for window.__rnReady(cfg) to be called before starting.

var STATUS  = document.getElementById('status');
var ROOM_EL = document.getElementById('room');
var ERROR   = document.getElementById('error');
var video   = document.getElementById('v');

var pc = null;
var socket;
var localStream;
var activeViewerSocketId = null;
var initialized = false;

function rn(msg) {
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(msg);
}

// Called by React Native with the full config object
window.__rnReady = function(cfg) {
  if (initialized) return;
  initialized = true;

  var TOKEN  = cfg.token  || '';
  var ROOM   = cfg.roomId || '';
  var SIGURL = cfg.signalingUrl || '';
  var ICE    = cfg.iceServers && cfg.iceServers.length
    ? { iceServers: cfg.iceServers }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  ROOM_EL.textContent = 'Room: ' + ROOM;

  // One RTCPeerConnection per viewer, keyed by viewer's socket ID
  var pcs = {};
  var viewerCount = 0;

  function updateStatus() {
    if (viewerCount === 0) {
      STATUS.textContent = 'Connected — waiting for viewer…';
    } else {
      STATUS.textContent = '✅ Streaming (' + viewerCount + ' viewer' + (viewerCount !== 1 ? 's' : '') + ')';
    }
  }

  function createPCForViewer(viewerSocketId) {
    if (pcs[viewerSocketId]) { try { pcs[viewerSocketId].close(); } catch(_) {} }
    var pc = new RTCPeerConnection(ICE);
    pcs[viewerSocketId] = pc;
    if (localStream) {
      localStream.getTracks().forEach(function(t) { pc.addTrack(t, localStream); });
    }
    pc.onicecandidate = function(e) {
      if (e.candidate && socket && socket.connected) {
        socket.emit('ice-candidate', { candidate: e.candidate, targetId: viewerSocketId });
      }
    };
    pc.oniceconnectionstatechange = function() {
      if (pc.iceConnectionState === 'failed') { pc.restartIce && pc.restartIce(); }
    };
    return pc;
  }

  async function startCamera() {
    STATUS.textContent = 'Requesting camera…';
    rn('camera-starting');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      var msg = 'mediaDevices API not available on this browser/device';
      ERROR.textContent = msg;
      STATUS.textContent = 'Camera not supported';
      rn('camera-error:' + msg);
      return;
    }
    var constraintSets = [
      { video: { facingMode: { exact: 'environment' } }, audio: true },
      { video: { facingMode: 'environment' }, audio: true },
      { video: true, audio: true },
      { video: true, audio: false },
    ];
    for (var i = 0; i < constraintSets.length; i++) {
      try {
        rn('camera-try:' + i);
        localStream = await navigator.mediaDevices.getUserMedia(constraintSets[i]);
        video.srcObject = localStream;
        STATUS.textContent = 'Camera ready — connecting…';
        rn('camera-ok');
        connectSocket();
        return;
      } catch (err) {
        rn('camera-fail:' + i + ':' + err.name + ':' + err.message);
        if (i === constraintSets.length - 1) {
          ERROR.textContent = 'Camera error: ' + err.name + ' — ' + err.message;
          STATUS.textContent = 'Could not access camera';
          rn('camera-error:' + err.name + ':' + err.message);
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
        viewerCount++;
        STATUS.textContent = 'Viewer joined — setting up stream…';
        createPCForViewer(data.socketId);
        socket.emit('request-offer', { targetId: data.socketId });
      }
    });
    // offer comes from a specific viewer (data.fromId = viewerSocketId)
    socket.on('offer', async function (data) {
      var pc = pcs[data.fromId];
      if (!pc) return;
      try {
        await pc.setRemoteDescription(data.sdp);
        var answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { sdp: { type: answer.type, sdp: answer.sdp }, targetId: data.fromId });
        updateStatus();
        rn('streaming');
      } catch (err) {
        ERROR.textContent = 'Stream error: ' + err.message;
      }
    });
    // ice-candidate from a specific viewer (data.fromId = viewerSocketId)
    socket.on('ice-candidate', async function (data) {
      var pc = pcs[data.fromId];
      if (pc && data.candidate) { try { await pc.addIceCandidate(data.candidate); } catch(_) {} }
    });
    // peer-disconnected includes socketId of the viewer that left
    socket.on('peer-disconnected', function (data) {
      if (data.role === 'viewer' && data.socketId) {
        if (pcs[data.socketId]) { try { pcs[data.socketId].close(); } catch(_) {} }
        delete pcs[data.socketId];
        viewerCount = Math.max(0, viewerCount - 1);
        updateStatus();
        if (viewerCount === 0) rn('viewer-left');
      }
    });
    socket.on('connect_error', function (err) {
      ERROR.textContent = 'Server error: ' + err.message;
    });
  }

  startCamera();
};

// If injectedJavaScriptBeforeContentLoaded already set __RN_CFG__, use it now
if (window.__RN_CFG__ && window.__RN_CFG__.token) {
  window.__rnReady(window.__RN_CFG__);
} else {
  // Final fallback: try URL hash (Android)
  try {
    var h = window.location.hash.substring(1);
    if (h) { var hcfg = JSON.parse(decodeURIComponent(h)); if (hcfg.token) window.__rnReady(hcfg); }
  } catch(_) {}
}
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
var STATUS  = document.getElementById('status');
var ROOM_EL = document.getElementById('room');
var ERROR   = document.getElementById('error');
var video   = document.getElementById('v');

var pc = null;
var socket = null;
var initialized = false;

function rn(msg) {
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(msg);
}

window.__rnReady = function(cfg) {
  if (initialized) return;
  initialized = true;

  var TOKEN  = cfg.token  || '';
  var ROOM   = cfg.roomId || '';
  var SIGURL = cfg.signalingUrl || '';
  var ICE    = cfg.iceServers && cfg.iceServers.length
    ? { iceServers: cfg.iceServers }
    : { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

  ROOM_EL.textContent = 'Room: ' + ROOM;

  var cameraSocketId = null; // learned from peer-joined, used to route all messages

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
    pc = new RTCPeerConnection(ICE);
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
      if (e.candidate && socket && socket.connected && cameraSocketId) {
        socket.emit('ice-candidate', { candidate: e.candidate, targetId: cameraSocketId });
      }
    };
    return pc;
  }

  socket = io(SIGURL, {
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
      cameraSocketId = data.socketId;
      STATUS.textContent = 'Monitor online — waiting for stream…';
    }
  });

  socket.on('room-error', function(data) {
    ERROR.textContent = data.message || 'Room error';
    STATUS.textContent = 'Could not join room';
    rn('room-error');
  });

  // Camera tells this viewer to create an offer
  socket.on('request-offer', async function() {
    STATUS.textContent = 'Setting up stream…';
    try {
      createPC();
      pc.addTransceiver('video', { direction: 'recvonly' });
      pc.addTransceiver('audio', { direction: 'recvonly' });
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('offer', { sdp: { type: offer.type, sdp: offer.sdp }, targetId: cameraSocketId });
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
};

// If injectedJavaScriptBeforeContentLoaded already set __RN_CFG__, use it now
if (window.__RN_CFG__ && window.__RN_CFG__.token) {
  window.__rnReady(window.__RN_CFG__);
} else {
  // Final fallback: try URL hash (Android)
  try {
    var h = window.location.hash.substring(1);
    if (h) { var hcfg = JSON.parse(decodeURIComponent(h)); if (hcfg.token) window.__rnReady(hcfg); }
  } catch(_) {}
}
</script>
</body>
</html>`;

// ── Routes (no auth — credentials are injected client-side) ───────────────────
// Override helmet's strict CSP for these WebView pages — they load CDN scripts
// and use inline JS, both of which the default CSP would silently block.
const WEBVIEW_CSP =
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; " +
  "connect-src * wss: ws: https:; " +
  "media-src * blob: data:;";

router.get('/monitor', (_req, res) => {
  res.setHeader('Content-Security-Policy', WEBVIEW_CSP);
  res.type('html').send(MONITOR_HTML);
});

router.get('/viewer', (_req, res) => {
  res.setHeader('Content-Security-Policy', WEBVIEW_CSP);
  res.type('html').send(VIEWER_HTML);
});

module.exports = router;
