// src/modules/admin/admin.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');
const { adminOnly } = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

router.use(auth, adminOnly);

/** GET /api/admin/dashboard — revenue, online, stats */
router.get('/dashboard', async (req, res) => {
  const now = new Date();
  const dayAgo = new Date(now - 86400000);
  const weekAgo = new Date(now - 7 * 86400000);

  const [
    totalUsers, onlineUsers,
    todayDeposits, weekDeposits,
    todayCaseOpens,
    pendingWithdrawals,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.userSession.count({ where: { expiresAt: { gt: now } } }),
    prisma.transaction.aggregate({ where: { type: 'deposit', status: 'completed', createdAt: { gte: dayAgo } }, _sum: { amount: true } }),
    prisma.transaction.aggregate({ where: { type: 'deposit', status: 'completed', createdAt: { gte: weekAgo } }, _sum: { amount: true } }),
    prisma.caseOpenResult.count({ where: { createdAt: { gte: dayAgo } } }),
    prisma.withdrawal.count({ where: { status: 'pending' } }),
  ]);

  res.json({
    totalUsers, onlineUsers,
    todayDeposits: todayDeposits._sum.amount || 0,
    weekDeposits: weekDeposits._sum.amount || 0,
    todayCaseOpens,
    pendingWithdrawals,
  });
});

/** GET /api/admin/users — search & list users */
router.get('/users', async (req, res) => {
  const { search, limit = 20, offset = 0 } = req.query;
  const where = {};
  if (search) {
    where.OR = [
      { username: { contains: search, mode: 'insensitive' } },
      { steamId: { contains: search } },
      { email: { contains: search } },
    ];
  }
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, take: Number(limit), skip: Number(offset), orderBy: { createdAt: 'desc' } }),
    prisma.user.count({ where }),
  ]);
  res.json({ users, total });
});

/** POST /api/admin/users/:id/ban */
router.post('/users/:id/ban', async (req, res) => {
  const { reason, days } = req.body;
  const banExpiresAt = days ? new Date(Date.now() + days * 86400000) : null;
  await prisma.user.update({
    where: { id: req.params.id },
    data: { isBanned: true, banReason: reason, banExpiresAt },
  });
  res.json({ ok: true });
});

/** POST /api/admin/users/:id/credit — manually add balance */
router.post('/users/:id/credit', async (req, res) => {
  const { amount, reason } = req.body;
  await prisma.$transaction([
    prisma.user.update({ where: { id: req.params.id }, data: { balance: { increment: amount } } }),
    prisma.transaction.create({ data: { userId: req.params.id, type: 'promo_bonus', amount, status: 'completed', meta: { reason } } }),
  ]);
  res.json({ ok: true });
});

/** GET /api/admin/withdrawals — list pending withdrawals */
router.get('/withdrawals', async (req, res) => {
  const { status = 'pending', limit = 50, offset = 0 } = req.query;
  const withdrawals = await prisma.withdrawal.findMany({
    where: { status },
    include: { user: { select: { username: true, steamId: true } } },
    take: Number(limit), skip: Number(offset),
    orderBy: { createdAt: 'asc' },
  });
  res.json(withdrawals);
});

/** POST /api/admin/withdrawals/:id/approve */
router.post('/withdrawals/:id/approve', async (req, res) => {
  await prisma.withdrawal.update({
    where: { id: req.params.id },
    data: { status: 'completed', processedAt: new Date() },
  });
  res.json({ ok: true });
});

/** CRUD cases */
router.post('/cases', async (req, res) => {
  const { name, price, category, imageUrl, items } = req.body;
  const slug = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  // Validate probabilities sum to ~1
  const sum = items.reduce((s, i) => s + Number(i.probability), 0);
  if (Math.abs(sum - 1) > 0.001) return res.status(400).json({ error: 'Probabilities must sum to 1' });

  const newCase = await prisma.case.create({
    data: {
      name, slug, price, category, imageUrl,
      items: { create: items.map(i => ({ itemId: i.itemId, probability: i.probability })) },
    },
    include: { items: true },
  });
  res.status(201).json(newCase);
});

/** POST /api/admin/promo — create promo code */
router.post('/promo', async (req, res) => {
  const { code, bonusType, bonusValue, minDeposit, maxUses, expiresAt } = req.body;
  const promo = await prisma.promoCode.create({
    data: { code: code.toUpperCase(), bonusType, bonusValue, minDeposit, maxUses, expiresAt: expiresAt ? new Date(expiresAt) : null },
  });
  res.status(201).json(promo);
});

module.exports = router;
