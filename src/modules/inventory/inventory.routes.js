// src/modules/inventory/inventory.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * @route   GET /api/inventory
 * @desc    Get user inventory
 * @query   status (in_inventory|withdrawn|sold), sort (price_desc|price_asc|date), limit, offset
 */
router.get('/', auth, async (req, res) => {
  const { status = 'in_inventory', sort = 'price_desc', limit = 50, offset = 0 } = req.query;

  const orderBy = sort === 'price_desc' ? { item: { marketPrice: 'desc' } }
                : sort === 'price_asc'  ? { item: { marketPrice: 'asc' } }
                : { receivedAt: 'desc' };

  const [items, total] = await Promise.all([
    prisma.userInventory.findMany({
      where: { userId: req.userId, status },
      include: { item: true },
      orderBy,
      take: Number(limit),
      skip: Number(offset),
    }),
    prisma.userInventory.count({ where: { userId: req.userId, status } }),
  ]);

  const totalValue = items.reduce((s, i) => s + Number(i.item.marketPrice), 0);
  res.json({ items, total, totalValue });
});

/**
 * @route   POST /api/inventory/:id/sell
 * @desc    Sell item — credit market price to balance
 */
router.post('/:id/sell', auth, async (req, res) => {
  const invItem = await prisma.userInventory.findFirst({
    where: { id: req.params.id, userId: req.userId, status: 'in_inventory' },
    include: { item: true },
  });
  if (!invItem) return res.status(404).json({ error: 'Item not found' });

  const sellPrice = Number(invItem.item.marketPrice);

  await prisma.$transaction([
    prisma.userInventory.update({ where: { id: invItem.id }, data: { status: 'sold' } }),
    prisma.user.update({ where: { id: req.userId }, data: { balance: { increment: sellPrice } } }),
    prisma.transaction.create({
      data: { userId: req.userId, type: 'sell_item', amount: sellPrice, status: 'completed' },
    }),
  ]);

  res.json({ ok: true, credited: sellPrice });
});

/**
 * @route   POST /api/inventory/sell-all
 * @desc    Sell all items in inventory
 */
router.post('/sell-all', auth, async (req, res) => {
  const items = await prisma.userInventory.findMany({
    where: { userId: req.userId, status: 'in_inventory' },
    include: { item: true },
  });

  const total = items.reduce((s, i) => s + Number(i.item.marketPrice), 0);
  const ids = items.map(i => i.id);

  await prisma.$transaction([
    prisma.userInventory.updateMany({ where: { id: { in: ids } }, data: { status: 'sold' } }),
    prisma.user.update({ where: { id: req.userId }, data: { balance: { increment: total } } }),
    prisma.transaction.create({ data: { userId: req.userId, type: 'sell_item', amount: total, status: 'completed' } }),
  ]);

  res.json({ ok: true, credited: total, count: ids.length });
});

module.exports = router;
