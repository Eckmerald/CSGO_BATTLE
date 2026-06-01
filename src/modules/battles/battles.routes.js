// src/modules/battles/battles.routes.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const auth = require('../../common/middleware/auth');

const router = express.Router();
const prisma = new PrismaClient();

/**
 * @route   GET /api/battles
 * @desc    List active/waiting battles
 * @query   mode, status, limit, offset
 * @access  Public
 */
router.get('/', async (req, res) => {
  const { mode, status = 'waiting', limit = 20, offset = 0 } = req.query;
  const where = { status: { in: ['waiting', 'countdown', 'active'] } };
  if (mode) where.mode = mode;

  const battles = await prisma.battle.findMany({
    where,
    take: Number(limit),
    skip: Number(offset),
    orderBy: { createdAt: 'desc' },
    include: {
      players: { include: { user: { select: { username: true, avatar: true, level: true } } } },
      cases: { include: { case: { select: { name: true, price: true, imageUrl: true } } } },
    },
  });

  res.json(battles);
});

/**
 * @route   GET /api/battles/:id
 * @desc    Get single battle details
 * @access  Public
 */
router.get('/:id', async (req, res) => {
  const battle = await prisma.battle.findUnique({
    where: { id: req.params.id },
    include: {
      players: {
        include: {
          user: { select: { username: true, avatar: true, level: true } },
        },
      },
      cases: { include: { case: true } },
      results: { include: { item: true } },
    },
  });
  if (!battle) return res.status(404).json({ error: 'Battle not found' });
  res.json(battle);
});

/**
 * @route   POST /api/battles
 * @desc    Create a new battle room
 * @body    { mode, caseIds: string[], gameMode }
 * @access  Private
 */
router.post('/', auth, async (req, res) => {
  const { mode = '1v1', caseIds, gameMode = 'normal', isPrivate = false } = req.body;

  if (!caseIds?.length) return res.status(400).json({ error: 'Select at least 1 case' });

  const modePlayerMap = { '1v1': 2, '2v2': 4, '1v1v1': 3, '1v1v1v1': 4, 'ffa': 4 };
  const maxPlayers = modePlayerMap[mode] || 2;

  // Calculate total bet per player
  const cases = await prisma.case.findMany({ where: { id: { in: caseIds } } });
  if (cases.length !== caseIds.length) return res.status(400).json({ error: 'Invalid cases' });
  const totalBet = cases.reduce((sum, c) => sum + Number(c.price), 0);

  // Check user balance
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (Number(user.balance) < totalBet) return res.status(400).json({ error: 'Insufficient balance' });

  const battle = await prisma.$transaction(async (tx) => {
    // Deduct balance
    await tx.user.update({ where: { id: req.userId }, data: { balance: { decrement: totalBet } } });
    await tx.transaction.create({ data: { userId: req.userId, type: 'battle_loss', amount: -totalBet, status: 'completed' } });

    // Create battle
    const newBattle = await tx.battle.create({
      data: {
        creatorId: req.userId,
        mode, gameMode, maxPlayers, isPrivate,
        inviteCode: isPrivate ? uuidv4().slice(0, 8).toUpperCase() : null,
        cases: {
          create: caseIds.map((caseId, order) => ({ caseId, order })),
        },
        players: {
          create: { userId: req.userId, slot: 0 },
        },
      },
      include: { cases: { include: { case: true } }, players: true },
    });

    return newBattle;
  });

  // Notify all clients about new battle
  req.app.get('io').emit('battle:created', battle);

  res.status(201).json(battle);
});

/**
 * @route   POST /api/battles/:id/join
 * @desc    Join an existing battle
 * @access  Private
 */
router.post('/:id/join', auth, async (req, res) => {
  const { inviteCode } = req.body;
  const battle = await prisma.battle.findUnique({
    where: { id: req.params.id },
    include: { players: true, cases: true },
  });

  if (!battle) return res.status(404).json({ error: 'Battle not found' });
  if (battle.status !== 'waiting') return res.status(400).json({ error: 'Battle already started' });
  if (battle.players.length >= battle.maxPlayers) return res.status(400).json({ error: 'Battle is full' });
  if (battle.isPrivate && battle.inviteCode !== inviteCode) return res.status(403).json({ error: 'Invalid invite code' });
  if (battle.players.some(p => p.userId === req.userId)) return res.status(400).json({ error: 'Already in battle' });

  // Calculate bet
  const cases = await prisma.case.findMany({ where: { id: { in: battle.cases.map(c => c.caseId) } } });
  const totalBet = cases.reduce((sum, c) => sum + Number(c.price), 0);

  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (Number(user.balance) < totalBet) return res.status(400).json({ error: 'Insufficient balance' });

  const updatedBattle = await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: req.userId }, data: { balance: { decrement: totalBet } } });
    await tx.transaction.create({ data: { userId: req.userId, type: 'battle_loss', amount: -totalBet, status: 'completed' } });

    await tx.battlePlayer.create({
      data: { battleId: battle.id, userId: req.userId, slot: battle.players.length },
    });

    // If full → start countdown
    if (battle.players.length + 1 >= battle.maxPlayers) {
      return tx.battle.update({ where: { id: battle.id }, data: { status: 'countdown' } });
    }
    return tx.battle.findUnique({ where: { id: battle.id } });
  });

  const io = req.app.get('io');
  io.emit('battle:player_joined', { battleId: battle.id, userId: req.userId });

  if (updatedBattle.status === 'countdown') {
    // Start battle after 5s countdown via socket handler
    io.emit('battle:countdown', { battleId: battle.id });
    setTimeout(() => startBattle(battle.id, io), 5000);
  }

  res.json(updatedBattle);
});

/**
 * Core battle execution — opens cases for all players simultaneously.
 */
async function startBattle(battleId, io) {
  const battle = await prisma.battle.findUnique({
    where: { id: battleId },
    include: {
      players: true,
      cases: { include: { case: { include: { items: { include: { item: true } } } } } },
    },
  });

  await prisma.battle.update({ where: { id: battleId }, data: { status: 'active' } });
  io.emit('battle:started', { battleId });

  const crypto = require('crypto');

  function roll(serverSeed, clientSeed, nonce) {
    const hmac = crypto.createHmac('sha256', serverSeed);
    hmac.update(`${clientSeed}:${nonce}`);
    const hash = hmac.digest('hex');
    return parseInt(hash.slice(0, 8), 16) / 0x100000000;
  }

  function pickItem(items, r) {
    let c = 0;
    for (const it of items) { c += Number(it.probability); if (r < c) return it; }
    return items[items.length - 1];
  }

  const playerTotals = {};
  battle.players.forEach(p => { playerTotals[p.userId] = 0; });

  // Process each case round
  for (const battleCase of battle.cases) {
    const roundResults = [];

    for (const player of battle.players) {
      const serverSeed = crypto.randomBytes(32).toString('hex');
      const nonce = Date.now();
      const r = roll(serverSeed, `${player.userId}:${battleId}`, nonce);
      const picked = pickItem(battleCase.case.items, r);

      playerTotals[player.userId] += Number(picked.item.marketPrice);

      await prisma.battleCaseResult.create({
        data: { battleId, userId: player.userId, caseId: battleCase.caseId, itemId: picked.itemId, round: battleCase.order },
      });

      roundResults.push({ userId: player.userId, item: picked.item });
    }

    io.emit('battle:round_result', { battleId, round: battleCase.order, results: roundResults });
    await new Promise(r => setTimeout(r, 1500)); // pause between rounds
  }

  // Determine winner
  const isCrazy = battle.gameMode === 'crazy';
  const winnerId = isCrazy
    ? Object.entries(playerTotals).sort((a, b) => a[1] - b[1])[0][0]
    : Object.entries(playerTotals).sort((a, b) => b[1] - a[1])[0][0];

  const totalPot = Object.values(playerTotals).reduce((s, v) => s + v, 0);

  // Award winner
  await prisma.$transaction([
    prisma.battle.update({
      where: { id: battleId },
      data: { status: 'finished', winnerId, finishedAt: new Date() },
    }),
    prisma.user.update({
      where: { id: winnerId },
      data: { balance: { increment: totalPot } },
    }),
    prisma.transaction.create({
      data: { userId: winnerId, type: 'battle_win', amount: totalPot, status: 'completed' },
    }),
  ]);

  io.emit('battle:finished', { battleId, winnerId, playerTotals });
}

module.exports = router;
module.exports.startBattle = startBattle;
