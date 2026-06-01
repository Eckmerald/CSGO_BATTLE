// src/modules/battles/battles.socket.js
const jwt = require('jsonwebtoken');

function initBattleSocket(io) {
  const battleNsp = io.of('/battles');

  // Auth middleware for socket
  battleNsp.use((socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers.cookie
      ?.split(';').find(c => c.trim().startsWith('access_token='))?.split('=')[1];

    if (!token) return next(new Error('Unauthorized'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = payload.sub;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  battleNsp.on('connection', (socket) => {
    console.log(`Battle socket connected: ${socket.userId}`);

    // Join a specific battle room (for spectators / players)
    socket.on('battle:watch', ({ battleId }) => {
      socket.join(`battle:${battleId}`);
    });

    socket.on('battle:leave', ({ battleId }) => {
      socket.leave(`battle:${battleId}`);
    });

    socket.on('disconnect', () => {
      console.log(`Battle socket disconnected: ${socket.userId}`);
    });
  });

  return battleNsp;
}

module.exports = { initBattleSocket };
