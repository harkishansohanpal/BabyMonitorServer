const { Server } = require('socket.io');
const { verifyIdToken } = require('../utils/firebase');
const logger = require('../utils/logger');

// roomId → { camera: socketId|null, viewer: socketId|null }
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
      currentRoom = roomId;
      currentRole = role;
      if (!rooms.has(roomId)) rooms.set(roomId, { camera: null, viewer: null });
      const room = rooms.get(roomId);

      if (role === 'camera') room.camera = socket.id;
      else room.viewer = socket.id;

      socket.join(roomId);
      logger.info('Signaling: join', { roomId, role, id: socket.id });

      // Notify the other peer
      socket.to(roomId).emit('peer-joined', { role, socketId: socket.id });
    });

    socket.on('offer',         data => socket.to(currentRoom).emit('offer',         data));
    socket.on('answer',        data => socket.to(currentRoom).emit('answer',        data));
    socket.on('ice-candidate', data => socket.to(currentRoom).emit('ice-candidate', data));
    socket.on('start-call',    ()   => socket.to(currentRoom).emit('start-call'));

    socket.on('disconnect', () => {
      if (currentRoom && rooms.has(currentRoom)) {
        const room = rooms.get(currentRoom);
        if (currentRole === 'camera') room.camera = null;
        else room.viewer = null;
        io.to(currentRoom).emit('peer-disconnected', { role: currentRole });
        logger.info('Signaling: disconnect', { roomId: currentRoom, role: currentRole });
      }
    });
  });

  logger.info('WebRTC signaling server ready');
  return io;
}

module.exports = setupSignaling;
