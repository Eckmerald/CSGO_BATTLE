// src/modules/notifications/chat.socket.js
const jwt = require('jsonwebtoken');

function initChatSocket(io) {
  const chatNsp = io.of('/chat');
  // const filter = new Filter(); // enable profanity filter in production

  chatNsp.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = payload.sub;
        socket.username = payload.username;
      } catch {}
    }
    next();
  });

  const recentMessages = []; // in-memory last 50 messages (use Redis in prod)

  chatNsp.on('connection', (socket) => {
    // Send history on connect
    socket.emit('chat:history', recentMessages.slice(-50));

    socket.on('chat:send', ({ text }) => {
      if (!socket.userId) return socket.emit('error', 'Login required');
      if (!text?.trim() || text.length > 200) return;

      // const clean = filter.clean(text);
      const msg = {
        id: Date.now(),
        userId: socket.userId,
        username: socket.username || 'Player',
        text: text.trim(),
        timestamp: new Date().toISOString(),
      };

      recentMessages.push(msg);
      if (recentMessages.length > 100) recentMessages.shift();

      chatNsp.emit('chat:message', msg);
    });
  });
}

module.exports = { initChatSocket };
