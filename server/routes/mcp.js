import express from 'express';
import { authMiddleware } from './auth.js';
import { getUser, saveUser } from '../lib/users.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { getMcpToolExecutor } from '../lib/mcpRuntime.js';

const router = express.Router();

function safeRegistry(registry) {
  if (!registry || typeof registry !== 'object') return { mcp_servers: {} };
  return { mcp_servers: { ...(registry.mcp_servers || {}) } };
}

function safeToolsCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return {};
  return Object.fromEntries(
    Object.entries(catalog).map(([serverId, tools]) => [serverId, Array.isArray(tools) ? tools : []])
  );
}

async function getUserMcpSettings(userId) {
  const user = await getUser(userId);
  const settings = user?.mcpSettings || {};
  const registry = safeRegistry(settings.registry);
  const toolsCatalog = safeToolsCatalog(settings.toolsCatalog);
  const apiKeys = settings.apiKeys || {};
  const apiKeyStatus = Object.fromEntries(Object.keys(apiKeys).map(k => [k, true]));
  return { registry, toolsCatalog, apiKeys, apiKeyStatus };
}

async function getDecryptedApiKeys(settings = {}) {
  const decryptedKeys = {};
  for (const [k, v] of Object.entries(settings.apiKeys || {})) {
    decryptedKeys[k] = await decrypt(v);
  }
  return decryptedKeys;
}

router.get('/config', authMiddleware, async (req, res) => {
  try {
    const { registry, apiKeyStatus, toolsCatalog } = await getUserMcpSettings(req.user.userId);
    res.json({ ok: true, registry, apiKeyStatus, toolsCatalog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', authMiddleware, async (req, res) => {
  try {
    const incoming = safeRegistry(req.body?.registry);
    const user = await getUser(req.user.userId);
    const existing = user?.mcpSettings || {};
    const nextServerIds = new Set(Object.keys(incoming.mcp_servers || {}));
    const nextCatalog = Object.fromEntries(
      Object.entries(safeToolsCatalog(existing.toolsCatalog)).filter(([serverId]) => nextServerIds.has(serverId))
    );
    await saveUser(req.user.userId, { mcpSettings: { ...existing, registry: incoming, toolsCatalog: nextCatalog } });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/validate', authMiddleware, async (req, res) => {
  try {
    const server = String(req.body?.server || '').trim();
    if (!server) return res.status(400).json({ error: 'server is required' });

    const user = await getUser(req.user.userId);
    const settings = user?.mcpSettings || {};
    const decryptedKeys = await getDecryptedApiKeys(settings);

    const executor = await getMcpToolExecutor({
      registryConfig: settings.registry,
      secretMap: decryptedKeys
    });

    const tools = await executor.listToolsForLLM(server, { openAIFormat: false });
    if (!tools.ok) return res.status(502).json({ ok: false, ...tools });

    const updatedCatalog = {
      ...safeToolsCatalog(settings.toolsCatalog),
      [server]: tools.data || []
    };

    await saveUser(req.user.userId, {
      mcpSettings: {
        ...settings,
        toolsCatalog: updatedCatalog
      }
    });

    res.json({ ok: true, connected: true, tools: tools.data || [] });
  } catch (err) {
    res.status(500).json({ ok: false, connected: false, error: err.message });
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

    const cached = safeToolsCatalog(settings.toolsCatalog)[server];
    if (Array.isArray(cached) && cached.length) {
      return res.json({ ok: true, data: cached, cached: true });
    }

    const decryptedKeys = await getDecryptedApiKeys(settings);

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
