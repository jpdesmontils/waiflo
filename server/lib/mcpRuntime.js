import fs from 'node:fs/promises';
import path from 'node:path';
import MCPRegistry from '../../mcp/mcp_registry.js';
import MCPClient from '../../mcp/mcp_client.js';
import MCPToolRuntime from '../../mcp/mcp_runtime.js';
import ToolExecutor from '../../tools/tool_executor.js';
import BaseMCPAdapter from '../../adapters/base_adapter.js';

let _defaultExecutor = null;

async function loadRegistryConfig() {
  const inlineJson = process.env.MCP_SERVERS_JSON?.trim();
  if (inlineJson) return JSON.parse(inlineJson);

  const filePath = process.env.MCP_SERVERS_FILE || path.resolve(process.cwd(), 'mcp_servers.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { mcp_servers: {} };
    throw err;
  }
}

function resolvePlaceholdersDeep(value, secretMap = {}) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
      if (secretMap[key] != null) return String(secretMap[key]);
      if (process.env[key] != null) return String(process.env[key]);
      return '';
    });
  }
  if (Array.isArray(value)) return value.map(v => resolvePlaceholdersDeep(v, secretMap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolvePlaceholdersDeep(v, secretMap)]));
  }
  return value;
}

function buildExecutor(registryConfig, secretMap) {
  const resolved = resolvePlaceholdersDeep(registryConfig || { mcp_servers: {} }, secretMap || {});
  const registry = new MCPRegistry(resolved);
  const client = new MCPClient({ registry });
  const runtime = new MCPToolRuntime({ registry, client, adapter: new BaseMCPAdapter() });
  return new ToolExecutor({ runtime });
}

export async function getMcpToolExecutor({ registryConfig, secretMap } = {}) {
  if (registryConfig) {
    return buildExecutor(registryConfig, secretMap);
  }

  if (_defaultExecutor) return _defaultExecutor;
  const config = await loadRegistryConfig();
  _defaultExecutor = buildExecutor(config, secretMap || {});
  return _defaultExecutor;
}

export default getMcpToolExecutor;
