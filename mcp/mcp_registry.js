import fs from 'node:fs/promises';

function toSafeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers || {}).filter(([, value]) => value !== undefined && value !== null)
  );
}

function toAllowedToolsSet(allowedTools) {
  if (!allowedTools) return null;
  return new Set(Array.isArray(allowedTools) ? allowedTools : []);
}

export class MCPRegistry {
  constructor(config = {}) {
    this.servers = new Map();
    this.load(config);
  }

  load(config = {}) {
    const entries = Object.entries(config.mcp_servers || {});
    entries.forEach(([id, serverConfig]) => this.register(id, serverConfig));
    return this;
  }

  async loadFromFile(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return this.load(parsed);
  }

  register(serverId, serverConfig = {}) {
    const normalized = {
      id: serverId,
      transport: serverConfig.transport || 'http',
      command: serverConfig.command,
      args: serverConfig.args || [],
      url: serverConfig.url,
      headers: toSafeHeaders(serverConfig.headers),
      env: { ...(serverConfig.env || {}) },
      auth: {
        type: serverConfig.auth?.type || null,
        tokenEnvVar: serverConfig.auth?.tokenEnvVar || null,
        headerName: serverConfig.auth?.headerName || 'Authorization'
      },
      timeoutMs: Number(serverConfig.timeoutMs || 30_000),
      retry: {
        retries: Number(serverConfig.retry?.retries || 0),
        backoffMs: Number(serverConfig.retry?.backoffMs || 250)
      },
      allowedTools: toAllowedToolsSet(serverConfig.allowedTools)
    };

    this.servers.set(serverId, normalized);
    return normalized;
  }

  unregister(serverId) {
    this.servers.delete(serverId);
  }

  listServerIds() {
    return [...this.servers.keys()];
  }

  get(serverId) {
    const config = this.servers.get(serverId);
    if (!config) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }

    const token = config.auth.tokenEnvVar
      ? process.env[config.auth.tokenEnvVar]
      : null;

    const authHeaders = token
      ? { [config.auth.headerName]: config.auth.type === 'bearer' ? `Bearer ${token}` : token }
      : {};

    return {
      ...config,
      headers: {
        ...config.headers,
        ...authHeaders
      }
    };
  }
}

export default MCPRegistry;
