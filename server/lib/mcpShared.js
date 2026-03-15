import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || './waiflo-data';
const TOOL_SCHEMAS_FILE = path.join(DATA_DIR, 'mcp-tool-schemas.json');
const REGISTRY_FILE = path.join(DATA_DIR, 'mcp-registry.json');

const DEFAULT_REGISTRY = [
  {
    id: 'mapbox',
    matchPattern: 'mcp\\.mapbox\\.com',
    matchFlags: 'i',
    headers: {
      Authorization: 'Bearer ${api_key}',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-03-26'
    }
  },
  {
    id: 'google-maps',
    matchPattern: 'maps\\.googleapis\\.com',
    matchFlags: 'i',
    headers: { Authorization: 'Bearer ${api_key}' }
  },
  {
    id: 'stripe',
    matchPattern: 'stripe\\.com',
    matchFlags: 'i',
    headers: { Authorization: 'Bearer ${api_key}' }
  },
  {
    id: 'notion',
    matchPattern: 'notion\\.(so|com)',
    matchFlags: 'i',
    headers: { Authorization: 'Bearer ${api_key}' }
  },
  {
    id: 'postgres',
    matchPattern: 'localhost|127\\.0\\.0\\.1',
    matchFlags: 'i',
    headers: {}
  }
];

const EMPTY_TOOL_SCHEMAS = { version: 1, tools: {} };

function normalizeUrl(url = '') {
  return String(url || '').trim().toLowerCase();
}

function makeToolSchemaKey(serverUrl, toolName) {
  return `${normalizeUrl(serverUrl)}::${String(toolName || '').trim()}`;
}

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJsonOrDefault(filePath, fallbackFactory) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const fallback = fallbackFactory();
    await fs.writeFile(filePath, JSON.stringify(fallback, null, 2), 'utf8');
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await ensureDataDir();
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readSharedMcpRegistry() {
  const payload = await readJsonOrDefault(REGISTRY_FILE, () => ({ version: 1, providers: DEFAULT_REGISTRY }));
  if (!Array.isArray(payload?.providers)) {
    return { version: 1, providers: DEFAULT_REGISTRY };
  }
  return payload;
}

export async function upsertSharedMcpRegistry() {
  const current = await readSharedMcpRegistry();
  const existingById = new Map((current.providers || []).map((p) => [String(p.id || '').trim(), p]));
  for (const entry of DEFAULT_REGISTRY) {
    if (!existingById.has(entry.id)) existingById.set(entry.id, entry);
  }

  const providers = [...existingById.values()];
  const next = { version: 1, providers, updatedAt: new Date().toISOString() };
  await writeJson(REGISTRY_FILE, next);
  return next;
}

export async function readSharedToolSchemas() {
  const payload = await readJsonOrDefault(TOOL_SCHEMAS_FILE, () => EMPTY_TOOL_SCHEMAS);
  if (!payload || typeof payload !== 'object' || typeof payload.tools !== 'object' || Array.isArray(payload.tools)) {
    return EMPTY_TOOL_SCHEMAS;
  }
  return payload;
}

export async function saveDiscoveredToolSchemas({ serverUrl, serverLabel = '', providerId = '', tools = [] } = {}) {
  if (!serverUrl || !Array.isArray(tools)) return;
  const current = await readSharedToolSchemas();
  const nextTools = { ...(current.tools || {}) };

  for (const tool of tools) {
    const toolName = String(tool?.name || '').trim();
    if (!toolName) continue;

    const key = makeToolSchemaKey(serverUrl, toolName);
    nextTools[key] = {
      key,
      server_url: normalizeUrl(serverUrl),
      server_label: String(serverLabel || '').trim(),
      provider_id: String(providerId || '').trim(),
      tool_name: toolName,
      description: String(tool?.description || ''),
      inputSchema: tool?.inputSchema || tool?.parameters || null,
      outputSchema: tool?.outputSchema || null,
      rawTool: tool,
      updatedAt: new Date().toISOString()
    };
  }

  const next = { version: 1, tools: nextTools, updatedAt: new Date().toISOString() };
  await writeJson(TOOL_SCHEMAS_FILE, next);
}

export async function getSharedToolSchema(serverUrl, toolName) {
  const payload = await readSharedToolSchemas();
  return payload?.tools?.[makeToolSchemaKey(serverUrl, toolName)] || null;
}

export function urlMatchesRegistry(serverUrl, providerRow) {
  const pattern = String(providerRow?.matchPattern || '').trim();
  if (!pattern) return false;
  try {
    const rx = new RegExp(pattern, providerRow?.matchFlags || 'i');
    return rx.test(String(serverUrl || ''));
  } catch {
    return false;
  }
}
