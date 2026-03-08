import express        from 'express';
import bcrypt         from 'bcryptjs';
import jwt            from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import rateLimit      from 'express-rate-limit';
import { encrypt, decrypt } from '../lib/crypto.js';
import { readUsers, saveUser, userExists, findByEmail, ensureUserDir } from '../lib/users.js';
import { PROVIDER_META } from '../lib/providers/index.js';

const router = express.Router();
const JWT_SECRET  = () => process.env.JWT_SECRET; // Required — validated at startup
const SALT_ROUNDS = 10;

const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_META); // ['anthropic','openai','perplexity','mistral']

// ── Rate limiting ──────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,                   // max 10 attempts per IP per window
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── REGISTER ──────────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
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
      apiKeyEnc: null,      // legacy field — kept for backward compat
      providerKeys: {},     // { anthropic: 'enc...', openai: 'enc...', ... }
      createdAt: new Date().toISOString()
    });

    const token = jwt.sign({ userId, email, plan: 'self-key' }, JWT_SECRET(), { expiresIn: '7d' });
    res.json({ token, userId, email, plan: 'self-key' });

  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const user = await findByEmail(email);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });

    const { userId, plan } = user;
    const token = jwt.sign({ userId, email, plan }, JWT_SECRET(), { expiresIn: '7d' });
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

  // Build per-provider key status (boolean — never expose the key itself)
  const providerKeys = u.providerKeys || {};
  const providerKeyStatus = {};
  for (const p of SUPPORTED_PROVIDERS) {
    // A provider has a key if it's in providerKeys, OR if it's anthropic with legacy apiKeyEnc
    providerKeyStatus[p] = !!(providerKeys[p] || (p === 'anthropic' && u.apiKeyEnc));
  }

  res.json({
    userId, email, plan,
    hasApiKey: !!(u.apiKeyEnc || Object.values(providerKeys).some(Boolean)), // legacy compat
    providerKeys: providerKeyStatus,
    createdAt: u.createdAt
  });
});

// ── SAVE API KEY ──────────────────────────────────────────────────
// Body: { provider: 'anthropic'|'openai'|'perplexity'|'mistral', apiKey: '...' }
// Legacy: { apiKey: '...' } with no provider → treated as anthropic
router.put('/apikey', authMiddleware, async (req, res) => {
  try {
    const { apiKey, provider: rawProvider } = req.body;
    const provider = (rawProvider || 'anthropic').toLowerCase();

    if (!SUPPORTED_PROVIDERS.includes(provider)) {
      return res.status(400).json({ error: `Unknown provider "${provider}". Supported: ${SUPPORTED_PROVIDERS.join(', ')}` });
    }
    if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 8) {
      return res.status(400).json({ error: 'API key must be at least 8 characters' });
    }

    const key = apiKey.trim();
    const meta = PROVIDER_META[provider];

    // Light prefix validation (only when key doesn't look like a generic token)
    if (meta.keyPrefix && !key.startsWith(meta.keyPrefix)) {
      console.warn(`[auth] provider="${provider}" key doesn't start with expected prefix "${meta.keyPrefix}" — proceeding anyway`);
    }

    const enc = await encrypt(key);
    const users = await readUsers();
    const u = users[req.user.userId] || {};
    const providerKeys = { ...(u.providerKeys || {}), [provider]: enc };

    await saveUser(req.user.userId, { providerKeys, plan: 'self-key' });
    res.json({ ok: true, provider, message: `${provider} API key saved and encrypted` });

  } catch (err) {
    console.error('apikey error:', err);
    res.status(500).json({ error: 'Failed to save API key' });
  }
});

// ── DELETE API KEY ────────────────────────────────────────────────
// Body: { provider: 'anthropic'|... } (optional — deletes all if omitted)
router.delete('/apikey', authMiddleware, async (req, res) => {
  try {
    const { provider: rawProvider } = req.body || {};
    const users = await readUsers();
    const u = users[req.user.userId] || {};

    if (rawProvider) {
      const provider = rawProvider.toLowerCase();
      if (!SUPPORTED_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: `Unknown provider "${provider}"` });
      }
      const providerKeys = { ...(u.providerKeys || {}) };
      delete providerKeys[provider];
      const patch = { providerKeys };
      // Also clear legacy field when deleting anthropic
      if (provider === 'anthropic') patch.apiKeyEnc = null;
      await saveUser(req.user.userId, patch);
      res.json({ ok: true, provider });
    } else {
      // Delete all
      await saveUser(req.user.userId, { apiKeyEnc: null, providerKeys: {} });
      res.json({ ok: true });
    }
  } catch (err) {
    console.error('apikey delete error:', err);
    res.status(500).json({ error: 'Failed to delete API key' });
  }
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
    console.error('password change error:', err);
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
