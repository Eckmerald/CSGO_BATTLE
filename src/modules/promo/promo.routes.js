// src/modules/promo/promo.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * @route   POST /api/promo/apply
 * @desc    Apply promo code to a deposit
 * @body    { code, depositAmount }
 */
router.post('/apply', auth, async (req, res) => {
  const { code, depositAmount } = req.body;

  const promo = await prisma.promoCode.findUnique({
    where: { code: code.toUpperCase() },
    include: { uses: { where: { userId: req.userId } } },
  });

  if (!promo) return res.status(404).json({ error: 'Promo code not found' });
  if (!promo.isActive) return res.status(400).json({ error: 'Promo code is inactive' });
  if (promo.expiresAt && promo.expiresAt < new Date()) return res.status(400).json({ error: 'Promo code expired' });
  if (promo.maxUses && promo.usedCount >= promo.maxUses) return res.status(400).json({ error: 'Promo code limit reached' });
  if (promo.uses.length > 0) return res.status(400).json({ error: 'Already used this code' });
  if (promo.minDeposit && depositAmount < Number(promo.minDeposit)) {
    return res.status(400).json({ error: `Min deposit for this code: ${promo.minDeposit} RUB` });
  }

  const bonus = promo.bonusType === 'percent'
    ? depositAmount * Number(promo.bonusValue) / 100
    : Number(promo.bonusValue);

  await prisma.$transaction([
    prisma.promoCodeUse.create({ data: { promoCodeId: promo.id, userId: req.userId } }),
    prisma.promoCode.update({ where: { id: promo.id }, data: { usedCount: { increment: 1 } } }),
    prisma.user.update({ where: { id: req.userId }, data: { balance: { increment: bonus } } }),
    prisma.transaction.create({
      data: { userId: req.userId, type: 'promo_bonus', amount: bonus, status: 'completed' },
    }),
  ]);

  res.json({ ok: true, bonus, message: `+${bonus.toFixed(2)} RUB credited` });
});

module.exports = router;
