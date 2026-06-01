// src/modules/upgrade/upgrade.routes.js
const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * @route   POST /api/upgrade
 * @desc    Attempt skin upgrade
 * @body    { inventoryItemId, targetItemId }
 * @access  Private
 */
router.post('/', auth, async (req, res) => {
  const { inventoryItemId, targetItemId } = req.body;

  const [invItem, targetItem] = await Promise.all([
    prisma.userInventory.findFirst({
      where: { id: inventoryItemId, userId: req.userId, status: 'in_inventory' },
      include: { item: true },
    }),
    prisma.item.findUnique({ where: { id: targetItemId } }),
  ]);

  if (!invItem) return res.status(404).json({ error: 'Item not found in inventory' });
  if (!targetItem) return res.status(404).json({ error: 'Target item not found' });

  const sourcePrice = Number(invItem.item.marketPrice);
  const targetPrice = Number(targetItem.marketPrice);

  if (sourcePrice >= targetPrice) return res.status(400).json({ error: 'Target must be more expensive' });

  // Chance = (source / target) * platform_multiplier
  const PLATFORM_MULTIPLIER = 0.9; // house edge 10%
  const chance = Math.min(0.95, (sourcePrice / targetPrice) * PLATFORM_MULTIPLIER);

  // Provably fair roll
  const serverSeed = crypto.randomBytes(32).toString('hex');
  const clientSeed = req.body.clientSeed || 'default';
  const nonce = Date.now();
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(`${clientSeed}:${nonce}`);
  const hash = hmac.digest('hex');
  const roll = parseInt(hash.slice(0, 8), 16) / 0x100000000;

  const won = roll < chance;

  await prisma.$transaction(async (tx) => {
    // Remove source item
    await tx.userInventory.update({ where: { id: inventoryItemId }, data: { status: 'sold' } });

    if (won) {
      // Add target item
      await tx.userInventory.create({
        data: { userId: req.userId, itemId: targetItemId, sourceType: 'upgrade_win' },
      });
    }
  });

  res.json({
    won, roll, chance,
    item: won ? targetItem : null,
    serverSeed,
    serverSeedHash: crypto.createHash('sha256').update(serverSeed).digest('hex'),
  });
});

module.exports = router;
