// src/common/middleware/auth.js
const jwt = require('jsonwebtoken');

/**
 * Verifies JWT from httpOnly cookie or Authorization header.
 * Attaches userId to req.userId.
 */
module.exports = function authMiddleware(req, res, next) {
  let token = req.cookies?.access_token;

  // Also accept Bearer token (for API clients)
  if (!token && req.headers.authorization?.startsWith('Bearer ')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Admin-only middleware — check user role via DB
 */
module.exports.adminOnly = async (req, res, next) => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};
