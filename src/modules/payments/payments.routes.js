// src/modules/payments/payments.routes.js
const express = require('express');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

// ─── Deposit ──────────────────────────────────────────────────

/**
 * @route   POST /api/payments/deposit/init
 * @desc    Init deposit — create payment order, return redirect URL
 * @body    { amount: number, method: 'card'|'sbp'|'yoomoney'|'crypto' }
 * @access  Private
 */
router.post('/deposit/init', auth, async (req, res) => {
  const { amount, method } = req.body;

  if (!amount || amount < 50) return res.status(400).json({ error: 'Min deposit: 50 RUB' });

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Create pending transaction
  const tx = await prisma.transaction.create({
    data: {
      userId: req.userId,
      type: 'deposit',
      amount,
      currency: 'RUB',
      status: 'pending',
      paymentMethod: method,
    },
  });

  // Build payment URL depending on gateway
  // In production — integrate with Prodamus / Unitpay / Enot.io
  const paymentUrl = buildPaymentUrl({ method, amount, txId: tx.id, user });

  res.json({ transactionId: tx.id, paymentUrl });
});

/**
 * @route   POST /api/payments/deposit/webhook
 * @desc    Payment gateway webhook — verify signature & credit balance
 * @access  Public (but signature-verified)
 */
router.post('/deposit/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-signature'] || req.headers['x-prodamus-signature'];
  const body = req.body.toString();

  // Verify HMAC signature from gateway
  const expected = crypto.createHmac('sha256', process.env.PAYMENT_SECRET)
    .update(body).digest('hex');

  if (signature !== expected) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const payload = JSON.parse(body);
  const { order_id: txId, status, amount } = payload;

  if (status !== 'paid') return res.json({ ok: true }); // ignore non-paid

  const tx = await prisma.transaction.findUnique({ where: { id: txId } });
  if (!tx || tx.status !== 'pending') return res.json({ ok: true });

  // Credit balance atomically
  await prisma.$transaction([
    prisma.transaction.update({ where: { id: txId }, data: { status: 'completed' } }),
    prisma.user.update({ where: { id: tx.userId }, data: { balance: { increment: Number(amount) } } }),
  ]);

  res.json({ ok: true });
});

// ─── Withdraw ─────────────────────────────────────────────────

/**
 * @route   POST /api/payments/withdraw
 * @desc    Request withdrawal (money or Steam skin)
 * @body    { method: 'steam'|'card'|'crypto', amount?, itemId?, address? }
 * @access  Private
 */
router.post('/withdraw', auth, async (req, res) => {
  const { method, amount, itemId, address, tradeUrl } = req.body;

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (method === 'steam') {
    // Validate item in inventory
    if (!itemId) return res.status(400).json({ error: 'Item ID required for Steam withdrawal' });
    if (!tradeUrl) return res.status(400).json({ error: 'Trade URL required' });

    const invItem = await prisma.userInventory.findFirst({
      where: { id: itemId, userId: req.userId, status: 'in_inventory' },
      include: { item: true },
    });
    if (!invItem) return res.status(404).json({ error: 'Item not found in inventory' });

    const withdrawal = await prisma.$transaction(async (tx) => {
      await tx.userInventory.update({ where: { id: itemId }, data: { status: 'withdrawn' } });
      return tx.withdrawal.create({
        data: { userId: req.userId, method: 'steam', itemId: invItem.itemId, tradeUrl, status: 'pending' },
      });
    });

    // Queue Steam trade offer
    await queueSteamTrade({ withdrawalId: withdrawal.id, tradeUrl, item: invItem.item });

    return res.json({ withdrawal, message: 'Trade offer will be sent within 5 minutes' });
  }

  // Money withdrawal
  if (!amount || amount < 100) return res.status(400).json({ error: 'Min withdrawal: 100 RUB' });

  const commission = method === 'card' ? 0.07 : method === 'crypto' ? 0.05 : 0.05;
  const netAmount = amount * (1 - commission);

  if (Number(user.balance) < amount) return res.status(400).json({ error: 'Insufficient balance' });

  // Check wager requirement (must open cases equal to 100% of deposit)
  // (simplified — full implementation checks total_wagered vs total_deposited)

  const withdrawal = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: req.userId }, data: { balance: { decrement: amount } } });
    await tx.transaction.create({
      data: { userId: req.userId, type: 'withdrawal', amount: -amount, status: 'pending', paymentMethod: method },
    });
    return tx.withdrawal.create({
      data: { userId: req.userId, method, amount: netAmount, address, status: 'pending' },
    });
  });

  res.json({ withdrawal, netAmount, commission: `${(commission * 100).toFixed(0)}%` });
});

/**
 * @route   GET /api/payments/history
 * @desc    Get user transaction history
 * @query   type, limit, offset
 * @access  Private
 */
router.get('/history', auth, async (req, res) => {
  const { type, limit = 20, offset = 0 } = req.query;
  const where = { userId: req.userId };
  if (type) where.type = type;

  const [transactions, total] = await Promise.all([
    prisma.transaction.findMany({
      where, take: Number(limit), skip: Number(offset),
      orderBy: { createdAt: 'desc' },
    }),
    prisma.transaction.count({ where }),
  ]);

  res.json({ transactions, total, limit: Number(limit), offset: Number(offset) });
});

// ─── Helpers ──────────────────────────────────────────────────
function buildPaymentUrl({ method, amount, txId, user }) {
  // TODO: integrate with actual payment gateways
  // Prodamus: https://prodamus.ru/api
  // Unitpay: https://unitpay.money/api
  // Enot.io: https://enot.io/api
  const base = process.env.PAYMENT_GATEWAY_URL;
  return `${base}/pay?order_id=${txId}&amount=${amount}&method=${method}&email=${user.email || ''}`;
}

async function queueSteamTrade({ withdrawalId, tradeUrl, item }) {
  // TODO: call Steam Trade Bot service
  // Steam bot sends trade offer via node-steam-tradeoffer-manager
  const { getRedis } = require('../../config/redis');
  const redis = getRedis();
  await redis.lPush('steam:trade_queue', JSON.stringify({ withdrawalId, tradeUrl, item }));
}

module.exports = router;
