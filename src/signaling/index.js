const { Server } = require('socket.io');
const { verifyIdToken } = require('../utils/firebase');
const logger = require('../utils/logger');

// roomId (= camera's Firebase UID) → { camera: socketId|null, viewers: Set<socketId> }
const rooms = new Map();

function setupSignaling(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
  });

  // Authenticate every socket connection via Firebase token
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      socket.firebaseUser = await verifyIdToken(token);
      next();
    } catch (err) {
      logger.warn('Signaling: auth failed', { error: err.message });
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info('Signaling: client connected', { id: socket.id, uid: socket.firebaseUser?.uid });
    let currentRoom = null;
    let currentRole = null;

    socket.on('join', ({ roomId, role }) => {
      if (role === 'camera') {
        // Security: room ID is always the monitor's own Firebase UID
        currentRoom = socket.firebaseUser.uid;
        currentRole = 'camera';

        if (!rooms.has(currentRoom)) rooms.set(currentRoom, { camera: null, viewers: new Set() });
        const room = rooms.get(currentRoom);
        room.camera = socket.id;
        socket.join(currentRoom);
        logger.info('Signaling: camera joined', { roomId: currentRoom, id: socket.id });

        // Notify each waiting viewer about the camera, and tell camera about each viewer
        room.viewers.forEach(viewerSocketId => {
          io.to(viewerSocketId).emit('peer-joined', { role: 'camera', socketId: socket.id });
          socket.emit('peer-joined', { role: 'viewer', socketId: viewerSocketId });
        });

      } else if (role === 'viewer') {
        const targetRoom = roomId;

        if (!targetRoom || typeof targetRoom !== 'string' || targetRoom.trim().length < 10) {
          socket.emit('room-error', { message: 'Invalid room code.' });
          return;
        }

        if (!rooms.has(targetRoom)) rooms.set(targetRoom, { camera: null, viewers: new Set() });
        const room = rooms.get(targetRoom);

        currentRoom = targetRoom;
        currentRole = 'viewer';
        room.viewers.add(socket.id);
        socket.join(currentRoom);
        logger.info('Signaling: viewer joined', {
          roomId: currentRoom,
          viewerCount: room.viewers.size,
          cameraPresent: !!room.camera,
          id: socket.id,
        });

        if (room.camera) {
          // Tell camera about the new viewer
          io.to(room.camera).emit('peer-joined', { role: 'viewer', socketId: socket.id });
          // Tell viewer about the camera so it can route messages back
          socket.emit('peer-joined', { role: 'camera', socketId: room.camera });
        } else {
          socket.emit('waiting-for-camera', { message: 'Waiting for the monitor phone to connect…' });
          logger.info('Signaling: viewer waiting for camera', { roomId: currentRoom });
        }
      }
    });

    // All signaling messages are routed directly to a specific target socket.
    // targetId is required for new clients. Old clients omit it — we fall back
    // to role-based routing so old app builds keep working during upgrades.

    socket.on('request-offer', (data) => {
      const targetId = data && data.targetId;
      if (targetId) {
        io.to(targetId).emit('request-offer');
      } else {
        // Old client (no targetId) — broadcast to room
        socket.to(currentRoom).emit('request-offer');
      }
    });

    socket.on('offer', (data) => {
      const { sdp, targetId } = data || {};
      if (targetId) {
        io.to(targetId).emit('offer', { sdp, fromId: socket.id });
      } else if (currentRole === 'viewer') {
        // Viewer always sends offer to camera — route directly
        const room = rooms.get(currentRoom);
        if (room && room.camera) {
          io.to(room.camera).emit('offer', { sdp, fromId: socket.id });
        }
      } else {
        socket.to(currentRoom).emit('offer', { sdp, fromId: socket.id });
      }
    });

    socket.on('answer', (data) => {
      const { sdp, targetId } = data || {};
      if (targetId) {
        io.to(targetId).emit('answer', { sdp, fromId: socket.id });
      } else {
        socket.to(currentRoom).emit('answer', { sdp, fromId: socket.id });
      }
    });

    socket.on('ice-candidate', (data) => {
      const { candidate, targetId } = data || {};
      if (targetId) {
        io.to(targetId).emit('ice-candidate', { candidate, fromId: socket.id });
      } else if (currentRole === 'viewer') {
        // Viewer's ICE candidates always go to camera
        const room = rooms.get(currentRoom);
        if (room && room.camera) {
          io.to(room.camera).emit('ice-candidate', { candidate, fromId: socket.id });
        }
      } else {
        // Camera without targetId — broadcast (old client behaviour)
        socket.to(currentRoom).emit('ice-candidate', { candidate, fromId: socket.id });
      }
    });

    socket.on('disconnect', () => {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        if (currentRole === 'camera') {
          room.camera = null;
          // Notify all viewers the camera left
          room.viewers.forEach(viewerSocketId => {
            io.to(viewerSocketId).emit('peer-disconnected', { role: 'camera', socketId: socket.id });
          });
          logger.info('Signaling: camera disconnected', { roomId: currentRoom });
        } else if (currentRole === 'viewer') {
          room.viewers.delete(socket.id);
          // Notify camera that this specific viewer left
          if (room.camera) {
            io.to(room.camera).emit('peer-disconnected', { role: 'viewer', socketId: socket.id });
          }
          logger.info('Signaling: viewer disconnected', {
            roomId: currentRoom,
            viewerCount: room.viewers.size,
          });
        }
      }
    });
  });

  logger.info('WebRTC signaling server ready');
  return io;
}

module.exports = setupSignaling;
