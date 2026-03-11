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

const MCP_REGISTRY = [
  { id: 'mapbox',      match: /mcp\.mapbox\.com/i,              headers: (k) => ({ 'Authorization': `Bearer ${k}`, 'Accept': 'application/json, text/event-stream' }) },
  { id: 'google-maps', match: /maps\.googleapis\.com/i,         headers: (k) => ({ 'Authorization': `Bearer ${k}` }) },
  { id: 'stripe',      match: /stripe\.com/i,                   headers: (k) => ({ 'Authorization': `Bearer ${k}` }) },
  { id: 'notion',      match: /notion\.(so|com)/i,              headers: (k) => ({ 'Authorization': `Bearer ${k}` }) },
  { id: 'postgres',    match: /localhost|127\.0\.0\.1/i,        headers: ()  => ({}) },
];

const FALLBACK_STRATEGIES = [
  (k) => ({ 'Authorization': `Bearer ${k}` }),
  (k) => ({ 'Authorization': `Bearer ${k}`, 'Accept': 'application/json, text/event-stream' }),
  (k) => ({ 'x-api-key': k }),
  ()  => ({}),
];

const PAYLOAD = JSON.stringify({ jsonrpc: '2.0', id: 'discover-tools', method: 'tools/list', params: {} });

async function fetchTools(url, extraHeaders, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: PAYLOAD,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    // SSE: read stream line by line until we find a tools array
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      const text = await res.text();
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const body = JSON.parse(line.slice(5).trim());
          if (body?.error) throw new Error(body.error?.message || 'MCP error');
          const tools = body?.result?.tools ?? body?.tools;
          if (Array.isArray(tools)) return tools;
        } catch {}
      }
      throw new Error('SSE stream: no tools found');
    }

    // Standard JSON
    const body = await res.json();
    if (body?.error) throw new Error(body.error?.message || 'MCP error');
    const tools = body?.result?.tools ?? body?.tools ?? [];
    if (!Array.isArray(tools)) throw new Error('Invalid response: tools not found');
    return tools;

  } finally {
    clearTimeout(timer);
  }
}

async function discoverMcpTools({ server_url, api_key, timeoutMs = 30_000 } = {}) {
  if (!server_url) throw new Error('server_url is required');

  const known = MCP_REGISTRY.find((p) => p.match.test(server_url));

  console.log(`[MCP] ${server_url} → ${known ? `provider: ${known.id}` : 'unknown, discovery mode'}`);

  // Known provider — direct attempt
  if (known) {
    const headers = known.headers(api_key);
    console.log(`[MCP] trying ${known.id} with headers:`, Object.keys(headers).join(', ') || 'none');
    return fetchTools(server_url, headers, timeoutMs);
  }

  // Unknown provider — try all strategies
  const errors = [];
  for (const [i, buildHeaders] of FALLBACK_STRATEGIES.entries()) {
    if (!api_key && i < FALLBACK_STRATEGIES.length - 1) continue; // skip auth strategies if no key
    const headers = buildHeaders(api_key);
    console.log(`[MCP] attempt ${i + 1}/${FALLBACK_STRATEGIES.length} — headers: ${Object.keys(headers).join(', ') || 'none'}`);
    try {
      return await fetchTools(server_url, headers, timeoutMs);
    } catch (err) {
      console.warn(`[MCP] ✗ ${err.message}`);
      errors.push(err.message);
    }
  }

  throw new Error(`discoverMcpTools failed:\n${errors.join('\n')}`);
}

async function sanitizeMcpServersForClient(rawServers = []) {
  return Promise.all((rawServers || []).map(async (srv) => {
    let apiKey = '';
    if (srv.apiKeyEnc) {
      try { apiKey = await decrypt(srv.apiKeyEnc); } catch { apiKey = ''; }
    }
    return {
      server_label: srv.server_label || '',
      server_url: srv.server_url || '',
      api_key: apiKey,
      transport: srv.transport || 'https',
      timeoutMs: srv.timeoutMs || 30000,
      tools: Array.isArray(srv.tools) ? srv.tools : [],
      last_status: srv.last_status || 'unknown',
      last_error: srv.last_error || ''
    };
  }));
}

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
      mcpServers: [],
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
    createdAt: u.createdAt,
    mcpServers: await sanitizeMcpServersForClient(u.mcpServers || [])
  });
});

router.post('/mcp-validate', authMiddleware, async (req, res) => {
  const startedAt = Date.now();
  const requestId = `mcpval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  console.log(`[MCP_VALIDATE][${requestId}] Incoming request`);

  try {
    const { server_label, server_url, api_key, timeoutMs } = req.body || {};
    const effectiveTimeoutMs = Number(timeoutMs) || 30000;

    console.log(`[MCP_VALIDATE][${requestId}] Payload received`, {
      server_label: server_label || null,
      server_url: server_url || null,
      has_api_key: !!(api_key && api_key.trim()),
      timeoutMs_raw: timeoutMs,
      timeoutMs_effective: effectiveTimeoutMs,
      user_id: req.user && req.user.id ? req.user.id : null
    });

    if (!server_label?.trim()) {
      console.warn(`[MCP_VALIDATE][${requestId}] Validation error: server_label is required`);
      return res.status(400).json({ error: 'server_label is required' });
    }

    if (!server_url?.trim()) {
      console.warn(`[MCP_VALIDATE][${requestId}] Validation error: server_url is required`);
      return res.status(400).json({ error: 'server_url is required' });
    }

    if (!api_key?.trim()) {
      console.warn(`[MCP_VALIDATE][${requestId}] Validation error: api_key is required`);
      return res.status(400).json({ error: 'api_key is required' });
    }

    console.log(`[MCP_VALIDATE][${requestId}] Starting MCP discovery`, {
      server_url: server_url.trim(),
      timeoutMs: effectiveTimeoutMs
    });

    const tools = await discoverMcpTools({
      server_url: server_url.trim(),
      api_key: api_key.trim(),
      timeoutMs: effectiveTimeoutMs
    });

    console.log(`[MCP_VALIDATE][${requestId}] MCP discovery succeeded`, {
      durationMs: Date.now() - startedAt,
      toolsCount: Array.isArray(tools) ? tools.length : null,
      toolNames: Array.isArray(tools) ? tools.map(t => t.name || t.id || 'unknown') : []
    });

    return res.json({
      ok: true,
      tools,
      count: Array.isArray(tools) ? tools.length : 0
    });
  } catch (err) {
    const durationMs = Date.now() - startedAt;

    console.error(`[MCP_VALIDATE][${requestId}] MCP discovery failed`, {
      durationMs,
      error_message: err && err.message ? err.message : 'Unknown error',
      error_name: err && err.name ? err.name : null,
      error_code: err && err.code ? err.code : null,
      error_type: err && err.type ? err.type : null,
      error_status: err && err.status ? err.status : null,
      error_statusCode: err && err.statusCode ? err.statusCode : null,
      error_errno: err && err.errno ? err.errno : null,
      error_stack: err && err.stack ? err.stack : null,
      error_response_data: err && err.response && err.response.data ? err.response.data : null
    });

    return res.status(502).json({
      error: err && err.message ? err.message : 'MCP validation failed',
      requestId
    });
  }
});

router.put('/mcp-servers', authMiddleware, async (req, res) => {
  try {
    const { mcp_servers } = req.body || {};
    if (!Array.isArray(mcp_servers)) return res.status(400).json({ error: 'mcp_servers must be an array' });

    const normalized = [];
    for (const row of mcp_servers) {
      const server_label = String(row?.server_label || '').trim();
      const server_url = String(row?.server_url || '').trim();
      const api_key = String(row?.api_key || '').trim();
      if (!server_label || !server_url || !api_key) {
        return res.status(400).json({ error: 'Each MCP server requires server_label, server_url and api_key' });
      }

      const tools = Array.isArray(row?.tools) ? row.tools : await discoverMcpTools({ server_url, api_key, timeoutMs: Number(row?.timeoutMs) || 30000 });
      normalized.push({
        server_label,
        server_url,
        transport: 'https',
        headers: { Authorization: 'Bearer ${api_key}' },
        timeoutMs: Number(row?.timeoutMs) || 30000,
        retry: { retries: 1, backoffMs: 300 },
        apiKeyEnc: await encrypt(api_key),
        tools,
        last_status: 'ok',
        last_error: '',
        updatedAt: new Date().toISOString()
      });
    }

    await saveUser(req.user.userId, { mcpServers: normalized });
    res.json({ ok: true, mcpServers: await sanitizeMcpServersForClient(normalized) });
  } catch (err) {
    console.error('mcp save error:', err);
    res.status(500).json({ error: err.message || 'Failed to save MCP servers' });
  }
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
