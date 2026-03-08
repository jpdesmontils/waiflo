import express        from 'express';
import bcrypt         from 'bcryptjs';
import jwt            from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { encrypt, decrypt } from '../lib/crypto.js';
import { readUsers, saveUser, userExists, findByEmail, ensureUserDir } from '../lib/users.js';

const router = express.Router();
const JWT_SECRET  = () => process.env.JWT_SECRET  || 'change-me';
const SALT_ROUNDS = 10;

// ── REGISTER ──────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 characters' });

    if (await userExists(email)) {
      return res.status(409).json({ error: 'email already registered' });
    }

    const userId       = uuid();
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

    await ensureUserDir(userId);
    await saveUser(userId, {
      email,
      passwordHash,
      plan: 'self-key',
      apiKeyEnc: null,
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId, email, plan: 'self-key' }, JWT_SECRET(), { expiresIn: '30d' });
    res.json({ token, userId, email, plan: 'self-key' });

  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await findByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { userId, plan } = user;
    const token = jwt.sign({ userId, email, plan }, JWT_SECRET(), { expiresIn: '30d' });
    res.json({ token, userId, email, plan });

  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── ME ────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  const { userId, email, plan } = req.user;
  const users = await readUsers();
  const u = users[userId] || {};
  res.json({
    userId, email, plan,
    hasApiKey: !!u.apiKeyEnc,
    createdAt: u.createdAt
  });
});

// ── SAVE API KEY ──────────────────────────────────────────────────
router.put('/apikey', authMiddleware, async (req, res) => {
  try {
    const { apiKey } = req.body;
    if (!apiKey || !apiKey.startsWith('sk-ant-')) {
      return res.status(400).json({ error: 'Invalid Anthropic API key format' });
    }
    const enc = encrypt(apiKey);
    await saveUser(req.user.userId, { apiKeyEnc: enc, plan: 'self-key' });
    res.json({ ok: true, message: 'API key saved and encrypted' });
  } catch (err) {
    console.error('apikey error:', err);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

// ── DELETE API KEY ────────────────────────────────────────────────
router.delete('/apikey', authMiddleware, async (req, res) => {
  await saveUser(req.user.userId, { apiKeyEnc: null });
  res.json({ ok: true });
});

// ── CHANGE PASSWORD ───────────────────────────────────────────────
router.put('/password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Both passwords required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });

    const user = await findByEmail(req.user.email);
    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Current password incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await saveUser(req.user.userId, { passwordHash });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to change password' });
  }
});

// ── MIDDLEWARE ────────────────────────────────────────────────────
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authorization required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export default router;