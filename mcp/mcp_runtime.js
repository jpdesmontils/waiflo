import BaseMCPAdapter from '../adapters/base_adapter.js';

function normalizeError(errorCode, message, details = {}) {
  return { ok: false, error_code: errorCode, message, details };
}

function validateInput(schema, input = {}) {
  if (!schema || typeof schema !== 'object') return { valid: true };

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (input[key] === undefined || input[key] === null) {
      return { valid: false, message: `Missing required input: ${key}` };
    }
  }

  return { valid: true };
}

function toOpenAITool(definition) {
  return {
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description || '',
      parameters: definition.inputSchema || {
        type: 'object',
        properties: definition.parameters || {},
        additionalProperties: true
      }
    }
  };
}

export class MCPToolRuntime {
  constructor({ registry, client, adapters = {}, logger = console, cacheTtlMs = 60_000 } = {}) {
    this.registry = registry;
    this.client = client;
    this.adapters = adapters;
    this.logger = logger;
    this.cacheTtlMs = cacheTtlMs;
    this.toolCache = new Map();
  }

  _adapterFor(serverId) {
    return this.adapters[serverId] || new BaseMCPAdapter();
  }

  _isAllowed(serverConfig, toolName) {
    if (!serverConfig.allowedTools) return true;
    return serverConfig.allowedTools.has(toolName);
  }

  async discoverTools(serverId, { useCache = true, openAIFormat = false } = {}) {
    const cacheKey = `${serverId}:${openAIFormat ? 'openai' : 'native'}`;
    const now = Date.now();
    const cached = this.toolCache.get(cacheKey);

    if (useCache && cached && cached.expiresAt > now) return cached.value;

    const adapter = this._adapterFor(serverId);
    const response = await this.client.listTools(serverId);
    if (!response.ok) return response;

    const toolList = response.data?.tools || response.data || [];
    const normalized = toolList
      .map(tool => adapter.normalizeToolDefinition(tool))
      .filter(tool => this._isAllowed(this.registry.get(serverId), tool.name));

    const result = openAIFormat ? normalized.map(toOpenAITool) : normalized;

    this.toolCache.set(cacheKey, {
      value: { ok: true, data: result },
      expiresAt: now + this.cacheTtlMs
    });

    return { ok: true, data: result };
  }

  async executeTool({ server, tool, input = {} }) {
    try {
      const serverConfig = this.registry.get(server);
      if (!this._isAllowed(serverConfig, tool)) {
        return normalizeError('MCP_TOOL_FORBIDDEN', `Tool not allowed: ${tool}`, { server, tool });
      }

      const adapter = this._adapterFor(server);
      const discovery = await this.discoverTools(server, { useCache: true, openAIFormat: false });
      if (!discovery.ok) return discovery;

      const toolDefinition = discovery.data.find(def => def.name === tool);
      if (!toolDefinition) {
        return normalizeError('MCP_TOOL_NOT_FOUND', `Tool not found: ${tool}`, { server, tool });
      }

      const validation = validateInput(toolDefinition.inputSchema, input);
      if (!validation.valid) {
        return normalizeError('MCP_INVALID_INPUT', validation.message, { server, tool });
      }

      const normalizedInput = adapter.normalizeInput(tool, input);
      const serverToolName = adapter.denormalizeToolName(tool);

      this.logger.info?.('[MCP Runtime] executeTool', { server, tool, serverToolName });

      const response = await this.client.callTool(server, serverToolName, normalizedInput);
      if (!response.ok) return response;

      const normalizedOutput = adapter.normalizeOutput(tool, response.data);
      return { ok: true, data: normalizedOutput };
    } catch (error) {
      return normalizeError('MCP_RUNTIME_ERROR', error.message || 'Unknown runtime error', {
        server,
        tool
      });
    }
  }
}

export default MCPToolRuntime;
