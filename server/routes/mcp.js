import express from 'express';
import { authMiddleware } from './auth.js';
import { getUser, saveUser } from '../lib/users.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { getMcpToolExecutor, MCP_ADAPTERS_META } from '../lib/mcpRuntime.js';

const router = express.Router();

function safeRegistry(registry) {
  if (!registry || typeof registry !== 'object') return { mcp_servers: {} };
  return { mcp_servers: { ...(registry.mcp_servers || {}) } };
}

async function getUserMcpSettings(userId) {
  const user = await getUser(userId);
  const settings = user?.mcpSettings || {};
  const registry = safeRegistry(settings.registry);
  const apiKeys = settings.apiKeys || {};
  const apiKeyStatus = Object.fromEntries(Object.keys(apiKeys).map(k => [k, true]));
  return { registry, apiKeys, apiKeyStatus };
}

router.get('/config', authMiddleware, async (req, res) => {
  try {
    const { registry, apiKeyStatus } = await getUserMcpSettings(req.user.userId);
    res.json({ ok: true, registry, apiKeyStatus, adapters: MCP_ADAPTERS_META });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', authMiddleware, async (req, res) => {
  try {
    const incoming = safeRegistry(req.body?.registry);
    const user = await getUser(req.user.userId);
    const existing = user?.mcpSettings || {};
    await saveUser(req.user.userId, { mcpSettings: { ...existing, registry: incoming } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.put('/apikey', authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const value = String(req.body?.value || '').trim();
    if (!name || !value) return res.status(400).json({ error: 'name and value required' });

    const enc = await encrypt(value);
    const user = await getUser(req.user.userId);
    const existing = user?.mcpSettings || {};
    const apiKeys = { ...(existing.apiKeys || {}), [name]: enc };

    await saveUser(req.user.userId, { mcpSettings: { ...existing, apiKeys } });
    res.json({ ok: true, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/apikey', authMiddleware, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });

    const user = await getUser(req.user.userId);
    const existing = user?.mcpSettings || {};
    const apiKeys = { ...(existing.apiKeys || {}) };
    delete apiKeys[name];

    await saveUser(req.user.userId, { mcpSettings: { ...existing, apiKeys } });
    res.json({ ok: true, name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/tools', authMiddleware, async (req, res) => {
  try {
    const server = String(req.query.server || '').trim();
    if (!server) return res.status(400).json({ error: 'server query param is required' });

    const user = await getUser(req.user.userId);
    const settings = user?.mcpSettings || {};
    const decryptedKeys = {};
    for (const [k, v] of Object.entries(settings.apiKeys || {})) {
      decryptedKeys[k] = await decrypt(v);
    }

    const executor = await getMcpToolExecutor({
      registryConfig: settings.registry,
      secretMap: decryptedKeys
    });

    const tools = await executor.listToolsForLLM(server, { openAIFormat: false });
    if (!tools.ok) return res.status(502).json(tools);

    res.json({ ok: true, data: tools.data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
