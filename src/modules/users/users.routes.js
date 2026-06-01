// src/modules/users/users.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * @route   GET /api/users/profile
 * @desc    Get own profile with stats
 */
router.get('/profile', auth, async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, username: true, avatar: true, steamId: true,
      balance: true, xp: true, level: true, referralCode: true,
      createdAt: true,
      _count: { select: { inventory: true } },
    },
  });

  // Stats
  const [casesOpened, battlesPlayed, bestDrop] = await Promise.all([
    prisma.caseOpenResult.count({ where: { userId: req.userId } }),
    prisma.battlePlayer.count({ where: { userId: req.userId } }),
    prisma.userInventory.findFirst({
      where: { userId: req.userId },
      include: { item: true },
      orderBy: { item: { marketPrice: 'desc' } },
    }),
  ]);

  res.json({
    ...user,
    stats: {
      casesOpened,
      battlesPlayed,
      bestDrop: bestDrop?.item || null,
    },
  });
});

/**
 * @route   POST /api/users/daily-bonus
 * @desc    Claim daily free spin bonus
 */
router.post('/daily-bonus', auth, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const existing = await prisma.dailyBonus.findFirst({
    where: { userId: req.userId, claimedAt: { gte: today } },
  });
  if (existing) return res.status(400).json({ error: 'Already claimed today', nextAt: getNextReset() });

  // Give free balance (50 RUB) or open a free case
  const DAILY_BONUS = 50;
  await prisma.$transaction([
    prisma.dailyBonus.create({ data: { userId: req.userId, bonus: DAILY_BONUS } }),
    prisma.user.update({ where: { id: req.userId }, data: { balance: { increment: DAILY_BONUS } } }),
    prisma.transaction.create({
      data: { userId: req.userId, type: 'promo_bonus', amount: DAILY_BONUS, status: 'completed' },
    }),
  ]);

  res.json({ ok: true, bonus: DAILY_BONUS });
});

/**
 * @route   GET /api/users/referrals
 * @desc    Get referral stats
 */
router.get('/referrals', auth, async (req, res) => {
  const referrals = await prisma.user.findMany({
    where: { referredBy: req.userId },
    select: { id: true, username: true, avatar: true, createdAt: true },
  });

  const earned = await prisma.transaction.aggregate({
    where: { userId: req.userId, type: 'referral_bonus' },
    _sum: { amount: true },
  });

  res.json({ referrals, count: referrals.length, totalEarned: earned._sum.amount || 0 });
});

/**
 * @route   GET /api/users/:steamId
 * @desc    Get public profile by Steam ID
 */
router.get('/:steamId', async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { steamId: req.params.steamId },
    select: {
      id: true, username: true, avatar: true, level: true, xp: true, createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

function getNextReset() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow;
}

module.exports = router;
