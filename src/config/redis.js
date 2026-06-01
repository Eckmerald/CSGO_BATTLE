// src/config/redis.js
const { createClient } = require('redis');
const logger = require('../common/utils/logger');

let client;

async function connectRedis() {
  client = createClient({ url: process.env.REDIS_URL });
  client.on('error', (err) => logger.error('Redis error:', err));
  await client.connect();
  logger.info('✅ Redis connected');
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialized. Call connectRedis() first.');
  return client;
}

module.exports = { connectRedis, getRedis };
