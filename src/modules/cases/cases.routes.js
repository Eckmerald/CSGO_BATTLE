// src/modules/cases/cases.routes.js
const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');
const { getRedis } = require('../../config/redis');

const router = express.Router();
const prisma = new PrismaClient();

// ─── Provably Fair Algorithm ──────────────────────────────────
/**
 * Generates a random server seed (stored as hash before reveal).
 */
function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Deterministically picks an item index from seeds.
 * Returns a float in [0, 1).
 */
function getResultFloat(serverSeed, clientSeed, nonce) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const hash = hmac.digest('hex');
  // Use first 8 hex chars → uint32 → [0,1)
  const intVal = parseInt(hash.slice(0, 8), 16);
  return intVal / 0x100000000;
}

/**
 * Picks an item based on probability table.
 * @param {Array} items - [{itemId, probability}]
 * @param {number} roll  - float [0,1)
 */
function pickItemByProbability(items, roll) {
  let cumulative = 0;
  for (const entry of items) {
    cumulative += Number(entry.probability);
    if (roll < cumulative) return entry;
  }
  // Fallback: last item (handles floating point edge cases)
  return items[items.length - 1];
}

// ─── Routes ───────────────────────────────────────────────────

/**
 * @route   GET /api/cases
 * @desc    Get all active cases with optional filters
 * @query   category, sort (price_asc|price_desc|newest), search
 * @access  Public
 */
router.get('/', async (req, res) => {
  const { category, sort, search } = req.query;

  const where = { isActive: true };
  if (category) where.category = category;
  if (search) where.name = { contains: search, mode: 'insensitive' };

  const orderBy = sort === 'price_asc'  ? { price: 'asc' }
                : sort === 'price_desc' ? { price: 'desc' }
                : { sortOrder: 'asc' };

  // Try Redis cache first
  const redis = getRedis();
  const cacheKey = `cases:list:${JSON.stringify({ where, orderBy })}`;
  const cached = await redis.get(cacheKey);
  if (cached) return res.json(JSON.parse(cached));

  const cases = await prisma.case.findMany({
    where,
    orderBy,
    select: {
      id: true, name: true, slug: true, price: true,
      imageUrl: true, category: true, sortOrder: true,
      _count: { select: { items: true } },
    },
  });

  await redis.setEx(cacheKey, 60, JSON.stringify(cases)); // cache 60s
  res.json(cases);
});

/**
 * @route   GET /api/cases/:slug
 * @desc    Get single case with all items and probabilities
 * @access  Public
 */
router.get('/:slug', async (req, res) => {
  const caseData = await prisma.case.findUnique({
    where: { slug: req.params.slug, isActive: true },
    include: {
      items: {
        include: { item: true },
        orderBy: { probability: 'desc' },
      },
    },
  });

  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  // Generate a server seed hash for Provably Fair
  const serverSeed = generateServerSeed();
  const serverSeedHash = crypto.createHash('sha256').update(serverSeed).digest('hex');

  // Store server seed in Redis temporarily (revealed after open)
  const redis = getRedis();
  await redis.setEx(`seed:${req.userId || 'anon'}:${caseData.id}`, 3600, serverSeed);

  res.json({ ...caseData, serverSeedHash });
});

/**
 * @route   POST /api/cases/:caseId/open
 * @desc    Open a case — deduct balance, run Provably Fair, return item
 * @body    { clientSeed: string, quantity: 1|2|3|5 }
 * @access  Private
 */
router.post('/:caseId/open', auth, async (req, res) => {
  const { clientSeed = 'default', quantity = 1 } = req.body;
  const { caseId } = req.params;
  const userId = req.userId;

  if (![1, 2, 3, 5].includes(Number(quantity))) {
    return res.status(400).json({ error: 'Invalid quantity' });
  }

  // Load case + items
  const caseData = await prisma.case.findUnique({
    where: { id: caseId, isActive: true },
    include: { items: { include: { item: true } } },
  });
  if (!caseData) return res.status(404).json({ error: 'Case not found' });

  const totalCost = Number(caseData.price) * quantity;

  // Atomic balance check + deduct using transaction
  const results = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.isBanned) throw new Error('USER_BANNED');
    if (Number(user.balance) < totalCost) throw new Error('INSUFFICIENT_BALANCE');

    // Deduct balance
    await tx.user.update({
      where: { id: userId },
      data: {
        balance: { decrement: totalCost },
        xp: { increment: Math.floor(totalCost / 10) }, // 1 XP per 10 RUB
      },
    });

    // Record case_open transaction
    await tx.transaction.create({
      data: { userId, type: 'case_open', amount: -totalCost, status: 'completed' },
    });

    const redis = getRedis();
    const openResults = [];

    for (let i = 0; i < quantity; i++) {
      // Get or generate server seed
      const seedKey = `seed:${userId}:${caseId}`;
      let serverSeed = await redis.get(seedKey);
      if (!serverSeed) serverSeed = generateServerSeed();

      const nonce = Date.now() + i;
      const roll = getResultFloat(serverSeed, clientSeed, nonce);
      const picked = pickItemByProbability(caseData.items, roll);

      // Add to inventory
      const invEntry = await tx.userInventory.create({
        data: {
          userId, itemId: picked.itemId,
          sourceType: 'case_open',
        },
      });

      // Record provably fair result
      await tx.caseOpenResult.create({
        data: {
          userId, caseId, itemId: picked.itemId,
          serverSeed, clientSeed, nonce,
          resultHash: crypto.createHash('sha256')
            .update(`${serverSeed}:${clientSeed}:${nonce}`)
            .digest('hex'),
        },
      });

      // Rotate seed for next open
      await redis.del(seedKey);

      openResults.push({
        inventoryId: invEntry.id,
        item: picked.item,
        serverSeed,  // revealed after open
        roll,
      });
    }

    return openResults;
  });

  // Emit live feed via Socket.IO
  const io = req.app.get('io');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { username: true, avatar: true } });
  results.forEach(r => {
    if (Number(r.item.marketPrice) > 1000) { // only announce big drops
      io.emit('live_feed', {
        username: user.username,
        avatar: user.avatar,
        item: r.item,
        caseId,
      });
    }
  });

  res.json({ results });
});

/**
 * @route   GET /api/cases/verify/:resultId
 * @desc    Provably Fair verification page data
 * @access  Public
 */
router.get('/verify/:resultId', async (req, res) => {
  const result = await prisma.caseOpenResult.findUnique({
    where: { id: req.params.resultId },
    include: { item: true, case: true },
  });
  if (!result) return res.status(404).json({ error: 'Result not found' });

  // Recompute to verify
  const roll = getResultFloat(result.serverSeed, result.clientSeed, result.nonce);
  const recomputedHash = crypto.createHash('sha256')
    .update(`${result.serverSeed}:${result.clientSeed}:${result.nonce}`)
    .digest('hex');

  res.json({
    ...result,
    roll,
    verified: recomputedHash === result.resultHash,
  });
});

module.exports = router;
