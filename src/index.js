require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const session = require('express-session');

const logger = require('./common/utils/logger');
const { errorHandler } = require('./common/middleware/errorHandler');
const { rateLimiter } = require('./common/middleware/rateLimiter');

// Routes
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/users.routes');
const caseRoutes = require('./modules/cases/cases.routes');
const battleRoutes = require('./modules/battles/battles.routes');
const upgradeRoutes = require('./modules/upgrade/upgrade.routes');
const inventoryRoutes = require('./modules/inventory/inventory.routes');
const paymentRoutes = require('./modules/payments/payments.routes');
const promoRoutes = require('./modules/promo/promo.routes');
const adminRoutes = require('./modules/admin/admin.routes');

// Socket handlers
const { initBattleSocket } = require('./modules/battles/battles.socket');
const { initChatSocket } = require('./modules/notifications/chat.socket');

const app = express();
const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL, credentials: true },
  transports: ['websocket', 'polling'],
});

// Attach io to app for use in route handlers
app.set('io', io);
initBattleSocket(io);
initChatSocket(io);

// ─── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 },
}));

app.use(rateLimiter);

// ─── Routes ───────────────────────────────────────────────────
app.use('/api/auth',      authRoutes);
app.use('/api/users',     userRoutes);
app.use('/api/cases',     caseRoutes);
app.use('/api/battles',   battleRoutes);
app.use('/api/upgrade',   upgradeRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/payments',  paymentRoutes);
app.use('/api/promo',     promoRoutes);
app.use('/api/admin',     adminRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── Error Handler ────────────────────────────────────────────
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`🚀 CASEX Backend running on port ${PORT}`);
  logger.info(`🌍 Environment: ${process.env.NODE_ENV}`);
});

module.exports = { app, server };
