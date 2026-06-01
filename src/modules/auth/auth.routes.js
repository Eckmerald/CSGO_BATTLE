// src/modules/auth/auth.routes.js
const express = require('express');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const router = express.Router();
const prisma = new PrismaClient();

// ─── Steam Passport Strategy ──────────────────────────────────
passport.use(new SteamStrategy({
  returnURL: `${process.env.API_URL}/api/auth/steam/return`,
  realm: process.env.API_URL,
  apiKey: process.env.STEAM_API_KEY,
}, async (identifier, profile, done) => {
  try {
    const steamId = profile.id;
    let user = await prisma.user.findUnique({ where: { steamId } });

    if (!user) {
      user = await prisma.user.create({
        data: {
          steamId,
          username: profile.displayName,
          avatar: profile.photos?.[2]?.value || profile.photos?.[0]?.value,
          referralCode: `CASEX-${steamId.slice(-6).toUpperCase()}`,
        },
      });
    } else {
      // Sync avatar & username from Steam
      user = await prisma.user.update({
        where: { steamId },
        data: {
          username: profile.displayName,
          avatar: profile.photos?.[2]?.value,
        },
      });
    }

    return done(null, user);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  const user = await prisma.user.findUnique({ where: { id } });
  done(null, user);
});

// ─── Token helpers ────────────────────────────────────────────
function generateTokens(userId) {
  const accessToken = jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
  const refreshToken = jwt.sign(
    { sub: userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: '30d' }
  );
  return { accessToken, refreshToken };
}

// ─── Routes ───────────────────────────────────────────────────

/**
 * @route   GET /api/auth/steam
 * @desc    Redirect to Steam login
 * @access  Public
 */
router.get('/steam', passport.authenticate('steam', { failureRedirect: '/login' }));

/**
 * @route   GET /api/auth/steam/return
 * @desc    Steam OAuth callback
 * @access  Public
 */
router.get('/steam/return',
  passport.authenticate('steam', { failureRedirect: `${process.env.CLIENT_URL}/login?error=steam_failed` }),
  async (req, res) => {
    const user = req.user;
    if (user.isBanned) {
      return res.redirect(`${process.env.CLIENT_URL}/banned`);
    }

    const { accessToken, refreshToken } = generateTokens(user.id);

    // Save session to DB
    await prisma.userSession.create({
      data: {
        userId: user.id,
        token: refreshToken,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // Set httpOnly cookies
    res.cookie('access_token', accessToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 15 * 60 * 1000,
    });
    res.cookie('refresh_token', refreshToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.redirect(`${process.env.CLIENT_URL}/?login=success`);
  }
);

/**
 * @route   POST /api/auth/refresh
 * @desc    Refresh access token
 * @access  Public (requires refresh_token cookie)
 */
router.post('/refresh', async (req, res) => {
  const token = req.cookies.refresh_token;
  if (!token) return res.status(401).json({ error: 'No refresh token' });

  try {
    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const session = await prisma.userSession.findUnique({ where: { token } });

    if (!session || session.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Session expired' });
    }

    const { accessToken } = generateTokens(payload.sub);
    res.cookie('access_token', accessToken, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax', maxAge: 15 * 60 * 1000,
    });

    res.json({ ok: true });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

/**
 * @route   POST /api/auth/logout
 * @desc    Logout — revoke session
 * @access  Private
 */
router.post('/logout', async (req, res) => {
  const token = req.cookies.refresh_token;
  if (token) {
    await prisma.userSession.deleteMany({ where: { token } });
  }
  res.clearCookie('access_token');
  res.clearCookie('refresh_token');
  res.json({ ok: true });
});

/**
 * @route   GET /api/auth/me
 * @desc    Get current user
 * @access  Private
 */
router.get('/me', require('../../common/middleware/auth'), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, username: true, avatar: true, steamId: true,
      balance: true, xp: true, level: true, referralCode: true,
      createdAt: true,
    },
  });
  res.json(user);
});

module.exports = router;
