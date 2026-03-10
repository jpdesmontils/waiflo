import { spawn } from 'node:child_process';

function normalizeError(errorCode, message, details = {}) {
  return {
    ok: false,
    error_code: errorCode,
    message,
    details
  };
}

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class MCPClient {
  constructor({ registry, logger = console } = {}) {
    this.registry = registry;
    this.logger = logger;
    this.connections = new Map();
  }

  async connect(serverId) {
    if (this.connections.has(serverId)) return this.connections.get(serverId);

    const config = this.registry.get(serverId);
    const connection = { config, transport: config.transport };

    if (config.transport === 'stdio') {
      connection.process = spawn(config.command, config.args, {
        env: { ...process.env, ...config.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
      connection.requestId = 0;
    }

    this.connections.set(serverId, connection);
    return connection;
  }

  async listTools(serverId) {
    return this._request(serverId, 'tools/list', {});
  }

  async callTool(serverId, toolName, params = {}) {
    return this._request(serverId, 'tools/call', { name: toolName, arguments: params });
  }

  async _request(serverId, method, params) {
    const { config } = await this.connect(serverId);

    const retryCount = config.retry?.retries || 0;
    let attempt = 0;

    while (attempt <= retryCount) {
      try {
        const result = await this._requestOnce(serverId, method, params, config.timeoutMs);
        return { ok: true, data: result };
      } catch (error) {
        if (attempt >= retryCount) {
          return normalizeError('MCP_TOOL_ERROR', error.message || 'Unknown MCP error', {
            serverId,
            method,
            attempt
          });
        }
        attempt += 1;
        await wait(config.retry.backoffMs * attempt);
      }
    }

    return normalizeError('MCP_TOOL_ERROR', 'Unexpected MCP retry state', { serverId, method });
  }

  async _requestOnce(serverId, method, params, timeoutMs) {
    const connection = await this.connect(serverId);
    const transport = connection.transport;

    if (transport === 'http') return this._requestHttp(connection.config, method, params, timeoutMs);
    if (transport === 'stdio') return this._requestStdio(connection, method, params, timeoutMs);
    if (transport === 'websocket') return this._requestWebSocket(connection.config, method, params, timeoutMs);

    throw new Error(`Unsupported MCP transport: ${transport}`);
  }

  async _requestHttp(config, method, params, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...config.headers
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} (${response.statusText})`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error.message || 'MCP JSON-RPC error');
      }

      return payload.result;
    } finally {
      clearTimeout(timeout);
    }
  }

  _requestStdio(connection, method, params, timeoutMs) {
    const id = ++connection.requestId;

    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      const chunks = [];

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`MCP stdio timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const onData = data => {
        chunks.push(data.toString());
        const lines = chunks.join('').split('\n');
        const completed = lines.slice(0, -1);
        chunks.length = 0;
        chunks.push(lines[lines.length - 1]);

        for (const line of completed) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.id !== id) continue;
            cleanup();
            if (message.error) reject(new Error(message.error.message || 'MCP stdio error'));
            else resolve(message.result);
          } catch {
            // ignore malformed line and keep listening
          }
        }
      };

      const onError = error => {
        cleanup();
        reject(error);
      };

      const cleanup = () => {
        clearTimeout(timeout);
        connection.process.stdout.off('data', onData);
        connection.process.stderr.off('data', onError);
      };

      connection.process.stdout.on('data', onData);
      connection.process.stderr.on('data', onError);
      connection.process.stdin.write(payload);
    });
  }

  _requestWebSocket(config, method, params, timeoutMs) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket transport is not available in this Node runtime');
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(config.url, { headers: config.headers });
      const id = Date.now();
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`MCP websocket timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      ws.onopen = () => {
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      };

      ws.onmessage = event => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.id !== id) return;
          clearTimeout(timeout);
          ws.close();
          if (message.error) reject(new Error(message.error.message || 'MCP websocket error'));
          else resolve(message.result);
        } catch (error) {
          clearTimeout(timeout);
          ws.close();
          reject(error);
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('MCP websocket connection error'));
      };
    });
  }
}

export default MCPClient;
