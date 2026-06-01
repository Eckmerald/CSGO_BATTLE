// src/common/middleware/errorHandler.js
const logger = require('../utils/logger');

exports.errorHandler = (err, req, res, next) => {
  logger.error(`${req.method} ${req.path} — ${err.message}`, { stack: err.stack });

  if (err.message === 'INSUFFICIENT_BALANCE') return res.status(400).json({ error: 'Insufficient balance' });
  if (err.message === 'USER_BANNED') return res.status(403).json({ error: 'Account is banned' });

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message });
};
