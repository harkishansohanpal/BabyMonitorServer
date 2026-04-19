const { Server } = require('socket.io');
const { verifyIdToken } = require('../utils/firebase');
const logger = require('../utils/logger');

// roomId (= camera's Firebase UID) → { camera: socketId|null, viewer: socketId|null }
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
        // Security: room ID is always the monitor's own Firebase UID — never
        // trust the client-supplied value for cameras.
        currentRoom = socket.firebaseUser.uid;
        currentRole = 'camera';

        if (!rooms.has(currentRoom)) rooms.set(currentRoom, { camera: null, viewer: null });
        const room = rooms.get(currentRoom);
        room.camera = socket.id;
        socket.join(currentRoom);
        logger.info('Signaling: camera joined', { roomId: currentRoom, id: socket.id });

        if (room.viewer) {
          // A viewer was already waiting — tell the camera so it creates the offer.
          socket.emit('peer-joined', { role: 'viewer', socketId: room.viewer });
          // Also let the viewer know the camera finally arrived.
          socket.to(currentRoom).emit('peer-joined', { role: 'camera', socketId: socket.id });
          logger.info('Signaling: camera joined room with waiting viewer', { roomId: currentRoom });
        }

      } else if (role === 'viewer') {
        const targetRoom = roomId;

        // Validate that the room code looks like a Firebase UID (non-empty string).
        if (!targetRoom || typeof targetRoom !== 'string' || targetRoom.trim().length < 10) {
          socket.emit('room-error', { message: 'Invalid room code.' });
          return;
        }

        // Allow viewer to join even if camera hasn't arrived yet — they'll wait.
        if (!rooms.has(targetRoom)) rooms.set(targetRoom, { camera: null, viewer: null });
        const room = rooms.get(targetRoom);

        currentRoom = targetRoom;
        currentRole = 'viewer';
        room.viewer = socket.id;
        socket.join(currentRoom);
        logger.info('Signaling: viewer joined', { roomId: currentRoom, cameraPresent: !!room.camera, id: socket.id });

        if (room.camera) {
          // Camera is already there — notify it so it creates an offer immediately.
          socket.to(currentRoom).emit('peer-joined', { role: 'viewer', socketId: socket.id });
        } else {
          // No camera yet — tell the viewer to show a "waiting" status.
          socket.emit('waiting-for-camera', {
            message: 'Waiting for the monitor phone to connect…',
          });
          logger.info('Signaling: viewer waiting for camera', { roomId: currentRoom });
        }
      }
    });

    socket.on('offer',          data => socket.to(currentRoom).emit('offer',          data));
    socket.on('answer',         data => socket.to(currentRoom).emit('answer',         data));
    socket.on('ice-candidate',  data => socket.to(currentRoom).emit('ice-candidate',  data));
    socket.on('request-offer',  ()   => socket.to(currentRoom).emit('request-offer'));
    socket.on('start-call',     ()   => socket.to(currentRoom).emit('start-call'));

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
