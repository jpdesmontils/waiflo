import fs from 'node:fs/promises';
import path from 'node:path';
import MCPRegistry from '../../mcp/mcp_registry.js';
import MCPClient from '../../mcp/mcp_client.js';
import MCPToolRuntime from '../../mcp/mcp_runtime.js';
import ToolExecutor from '../../tools/tool_executor.js';
import BaseMCPAdapter from '../../adapters/base_adapter.js';
import GoogleMapsAdapter from '../../adapters/google_maps_adapter.js';
import MapboxAdapter from '../../adapters/mapbox_adapter.js';

let _executor = null;

async function loadRegistryConfig() {
  const inlineJson = process.env.MCP_SERVERS_JSON?.trim();
  if (inlineJson) {
    return JSON.parse(inlineJson);
  }

  const filePath = process.env.MCP_SERVERS_FILE || path.resolve(process.cwd(), 'mcp_servers.json');
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return { mcp_servers: {} };
    throw err;
  }
}

function buildAdapters() {
  return {
    google_maps: new GoogleMapsAdapter(),
    mapbox: new MapboxAdapter(),
    default: new BaseMCPAdapter()
  };
}

export async function getMcpToolExecutor() {
  if (_executor) return _executor;

  const config = await loadRegistryConfig();
  const registry = new MCPRegistry(config);
  const client = new MCPClient({ registry });
  const runtime = new MCPToolRuntime({ registry, client, adapters: buildAdapters() });

  _executor = new ToolExecutor({ runtime });
  return _executor;
}

export default getMcpToolExecutor;
