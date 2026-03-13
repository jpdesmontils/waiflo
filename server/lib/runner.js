import { decrypt } from './crypto.js';
import { createProvider, PROVIDER_META } from './providers/index.js';
import { getSharedToolSchema, readSharedMcpRegistry, urlMatchesRegistry } from './mcpShared.js';

/**
 * Resolve the API key for a given provider from user record or env fallback.
 * Supports the legacy single-key field (apiKeyEnc) for backward compatibility.
 *
 * @param {object} user
 * @param {string} provider - anthropic | openai | perplexity | mistral
 * @returns {Promise<string>}
 */
async function resolveApiKey(user, provider) {
  const meta = PROVIDER_META[provider];

  // 1. Per-provider key stored in providerKeys map
  if (user.providerKeys?.[provider]) {
    return decrypt(user.providerKeys[provider]);
  }

  // 2. Legacy: anthropic key stored in apiKeyEnc (backward compat)
  if (provider === 'anthropic' && user.apiKeyEnc) {
    return decrypt(user.apiKeyEnc);
  }

  // 3. Server-level env var (managed / guest plan)
  const envKey = meta ? process.env[meta.envVar] : null;
  if (envKey) return envKey;

  throw new Error(
    `No API key for provider "${provider}". Add your key in Settings → API Keys.`
  );
}


function collectImageUrls(step, inputs) {
  const props = step?.ws_inputs_schema?.properties || {};
  const urls = [];

  for (const [key, schema] of Object.entries(props)) {
    if (schema?.type !== 'image_url') continue;
    const raw = inputs?.[key];
    if (!raw) continue;

    if (typeof raw === 'string') {
      urls.push(raw);
      continue;
    }

    if (Array.isArray(raw)) {
      raw.forEach(v => {
        if (typeof v === 'string') urls.push(v);
        else if (v && typeof v === 'object' && typeof v.url === 'string') urls.push(v.url);
      });
      continue;
    }

    if (typeof raw === 'object' && typeof raw.url === 'string') {
      urls.push(raw.url);
    }
  }

  return urls.filter(Boolean);
}

function buildPrompt(template, inputs) {
  let prompt = template;
  for (const [k, v] of Object.entries(inputs)) {
    const val = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    // triple braces = no escaping
    prompt = prompt.replaceAll(`{{{${k}}}}`, val);
    // double braces
    prompt = prompt.replaceAll(`{{${k}}}`, val);
  }
  return prompt;
}

/**
 * Execute a prompt step with SSE streaming.
 * Writes SSE events to res (Express response).
 */
export async function runPromptStep(step, inputs, user, req, res) {

  // Backward compatibility: some callers still pass (step, inputs, user, res).
  if (!res && req && typeof req.setHeader === 'function') {
    res = req;
    req = { query: { stream: '1' } };
  }

  const llm      = step.ws_llm || {};
  const provider = (llm.provider || 'anthropic').toLowerCase();
  const meta     = PROVIDER_META[provider] || PROVIDER_META.anthropic;

  const model  = llm.model || meta.defaultModel;
  const temp   = llm.temperature ?? 0;
  const maxTok = llm.max_tokens || 2048;
  const system = step.ws_system_prompt || '';

  const queryStream = req?.query?.stream;
  // Default to SSE for prompt execution unless explicitly disabled.
  const stream = !(queryStream === '0' || queryStream === 'false');

  let apiKey = await resolveApiKey(user, provider);
  const llmProvider = createProvider(provider, apiKey);
  apiKey = null;

  const allInputs = {
    ...inputs,
    ws_output_schema: JSON.stringify(step.ws_output_schema || {}, null, 2)
  };

  const userPrompt = buildPrompt(step.ws_prompt_template || '', allInputs);

  let send = () => {};

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    send = (event, data) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };
  }

  try {

    let fullText = '';

    const imageUrls = collectImageUrls(step, inputs);

    for await (const chunk of llmProvider.stream({
      model,
      system,
      userPrompt,
      imageUrls,
      temperature: temp,
      maxTokens: maxTok
    })) {

      const text = chunk.text || chunk.delta || chunk.content || '';

      if (text && stream) {
        send('token', { text });
      }

      fullText += text;
    }

    let parsed = null;

    try {
      const clean = fullText
        .replace(/^```json\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();

      parsed = JSON.parse(clean);

    } catch {
      parsed = null;
    }

    if (stream) {
      send('done', { full: fullText, parsed });
      res.end();
    } else {
      res.json({
        ok: true,
        full: fullText,
        parsed
      });
    }

    return {
      fullText,
      parsed,
      userPrompt,
      error: null
    };

  } catch (err) {

    if (stream) {
      send('error', { message: err.message });
      res.end();
    } else {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }

    return {
      fullText: '',
      parsed: null,
      userPrompt,
      error: err.message
    };
  }
}


export async function runPromptStep_legacy(step, inputs, user, res) {
  const llm      = step.ws_llm || {};
  const provider = (llm.provider || 'anthropic').toLowerCase();
  const meta     = PROVIDER_META[provider] || PROVIDER_META.anthropic;
  const model    = llm.model       || meta.defaultModel;
  const temp     = llm.temperature ?? 0;
  const maxTok   = llm.max_tokens  || 2048;
  const system   = step.ws_system_prompt || '';

  let apiKey = await resolveApiKey(user, provider);
  const llmProvider = createProvider(provider, apiKey);
  apiKey = null; // Clear from memory after use

  // Inject ws_output_schema into inputs so {{ws_output_schema}} resolves
  const allInputs = {
    ...inputs,
    ws_output_schema: JSON.stringify(step.ws_output_schema || {}, null, 2)
  };
  const userPrompt = buildPrompt(step.ws_prompt_template || '', allInputs);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let fullText = '';
    const imageUrls = collectImageUrls(step, inputs);
    for await (const chunk of llmProvider.stream({ model, system, userPrompt, imageUrls, temperature: temp, maxTokens: maxTok })) {
      send('token', { text: chunk.text });
      fullText += chunk.text;
    }

    // Try to parse as JSON
    let parsed = null;
    try {
      const clean = fullText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch { /* not JSON */ }

    send('done', { full: fullText, parsed });
    res.end();
    return { fullText, parsed, userPrompt, error: null };

  } catch (err) {
    send('error', { message: err.message });
    res.end();
    return { fullText: '', parsed: null, userPrompt, error: err.message };
  }
}


function renderTemplateString(template, vars) {
  let out = String(template ?? '');
  for (const [k, v] of Object.entries(vars || {})) {
    const val = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
    out = out.replaceAll(`{{{${k}}}}`, val);
    out = out.replaceAll(`{{${k}}}`, val);
  }
  return out;
}

function renderTemplateDeep(value, vars) {
  if (typeof value === 'string') return renderTemplateString(value, vars);
  if (Array.isArray(value)) return value.map(v => renderTemplateDeep(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderTemplateDeep(v, vars)]));
  }
  return value;
}

/**
 * Execute an API step (HTTP GET/POST/etc).
 * Returns { results, total, size } or raw response body.
 */
export async function runApiStep(step, inputs) {
  const apiConfig = step.ws_api || {};
  let url = renderTemplateString(apiConfig.url || '', inputs);

  const renderedQuery = renderTemplateDeep(apiConfig.query || {}, inputs);
  const queryEntries = Object.entries(renderedQuery || {}).filter(([, v]) => v !== undefined && v !== null && String(v) !== '');
  if (queryEntries.length) {
    const qs = new URLSearchParams();
    queryEntries.forEach(([k, v]) => qs.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
    url += (url.includes('?') ? '&' : '?') + qs.toString();
  }

  const method  = (apiConfig.method || 'GET').toUpperCase();
  const headers = { 'Accept': 'application/json', ...renderTemplateDeep(apiConfig.headers || {}, inputs) };

  const fetchOpts = { method, headers };
  if (apiConfig.body !== undefined && method !== 'GET') {
    const renderedBody = renderTemplateDeep(apiConfig.body, inputs);
    fetchOpts.body = JSON.stringify(renderedBody);
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  const response = await fetch(url, fetchOpts);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${response.statusText} — ${url}`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { raw: await response.text() };
}

async function runWebpageHttpStep(webpageConfig, inputs) {
  const url = renderTemplateString(webpageConfig.url || '', inputs);
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'User-Agent': webpageConfig.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...renderTemplateDeep(webpageConfig.headers || {}, inputs)
  };

  const response = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${response.statusText} — ${url}`);
  }

  return {
    url,
    finalUrl: response.url,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    html: await response.text(),
    meta: { mode: 'http' }
  };
}

async function runWebpageBrowserStep(webpageConfig, inputs) {
  let chromium = null;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('Playwright is required for ws_webpage.mode="browser". Install dependency: npm i playwright');
  }

  const url = renderTemplateString(webpageConfig.url || '', inputs);
  const headers = renderTemplateDeep(webpageConfig.headers || {}, inputs);
  const timeout = Number(webpageConfig.timeoutMs || 30000);
  const waitUntil = webpageConfig.waitUntil || 'networkidle';
  const waitForSelector = webpageConfig.waitForSelector ? renderTemplateString(webpageConfig.waitForSelector, inputs) : '';
  const viewport = webpageConfig.viewport && typeof webpageConfig.viewport === 'object'
    ? { width: Number(webpageConfig.viewport.width || 1366), height: Number(webpageConfig.viewport.height || 768) }
    : { width: 1366, height: 768 };

  let browser;
  const tsStart = Date.now();
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: webpageConfig.userAgent || undefined,
      viewport,
      extraHTTPHeaders: headers
    });

    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil, timeout });

    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout });
    }

    const html = await page.content();
    const title = await page.title();

    await context.close();

    return {
      url,
      finalUrl: page.url(),
      status: response?.status?.() || 200,
      contentType: response?.headers?.()['content-type'] || 'text/html',
      html,
      title,
      meta: {
        mode: 'browser',
        waitUntil,
        waitForSelector: waitForSelector || null,
        timingMs: Date.now() - tsStart
      }
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Execute a webpage step.
 * mode=http (default): simple fetch
 * mode=browser: Playwright headless render
 */
export async function runWebpageStep(step, inputs) {
  const webpageConfig = step.ws_webpage || step.ws_api || {};
  const mode = (webpageConfig.mode || 'http').toLowerCase();

  if (mode === 'browser') {
    return runWebpageBrowserStep(webpageConfig, inputs || {});
  }
  return runWebpageHttpStep(webpageConfig, inputs || {});
}

function resolveToolConfig(step) {
  const wsTool = step?.ws_tool || {};
  const mcpServerLabel = String(
    wsTool.mcp_server_label || wsTool.server_label || wsTool.server || ''
  ).trim();

  const toolName = String(
    wsTool.tool_name || wsTool.name || step?.ws_tools?.[0] || ''
  ).trim();

  if (!mcpServerLabel) throw new Error('tool step requires ws_tool.mcp_server_label');
  if (!toolName) throw new Error('tool step requires ws_tool.tool_name or ws_tools[0]');

  return { mcpServerLabel, toolName };
}

/**
 * Execute an MCP tool step against a configured user MCP server.
 */
function renderMcpHeaderValue(value, apiKey) {
  return String(value ?? '')
    .replaceAll('${api_key}', String(apiKey || ''))
    .replaceAll('{{api_key}}', String(apiKey || ''))
    .trim();
}

function buildToolArguments(inputs, toolSchema) {
  const safeInputs = (inputs && typeof inputs === 'object') ? inputs : {};

  if (safeInputs.arguments && typeof safeInputs.arguments === 'object' && !Array.isArray(safeInputs.arguments)) {
    return safeInputs.arguments;
  }

  const schema = toolSchema?.inputSchema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return safeInputs;
  }

  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  const declaredKeys = Object.keys(props);
  if (!declaredKeys.length) return safeInputs;

  const picked = {};
  for (const key of declaredKeys) {
    if (Object.prototype.hasOwnProperty.call(safeInputs, key)) {
      picked[key] = safeInputs[key];
    }
  }

  const result = Object.keys(picked).length ? picked : safeInputs;
  const required = Array.isArray(schema.required) ? schema.required : [];
  const missing = required.filter((k) => result[k] == null);
  if (missing.length) {
    throw new Error(`Missing required MCP tool arguments for "${toolSchema?.tool_name || 'unknown'}": ${missing.join(', ')}`);
  }

  return result;
}

function extractMcpRpcResultFromSse(rawText) {
  const lines = String(rawText || '').split('\n');
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    try {
      const body = JSON.parse(line.slice(5).trim());
      if (body?.error) throw new Error(body.error?.message || 'MCP error');
      if (body?.result != null) return body.result;
    } catch {
      // Continue until a valid JSON-RPC payload is found.
    }
  }
  throw new Error('SSE stream: no MCP result found');
}

async function parseMcpResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();

  if (contentType.includes('text/event-stream')) {
    const raw = await response.text();
    return extractMcpRpcResultFromSse(raw);
  }

  const body = await response.json();
  if (body?.error) throw new Error(body.error?.message || 'MCP error');
  return body?.result ?? body;
}

async function buildMcpRequestHeaders(server, apiKey) {
  const configured = (server?.headers && typeof server.headers === 'object') ? server.headers : {};
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream'
  };

  const registry = await readSharedMcpRegistry();
  const providers = Array.isArray(registry?.providers) ? registry.providers : [];
  const provider = providers.find((row) => urlMatchesRegistry(server?.server_url, row));
  const providerHeaders = (provider?.headers && typeof provider.headers === 'object') ? provider.headers : {};

  for (const [key, value] of Object.entries(providerHeaders)) {
    headers[key] = renderMcpHeaderValue(value, apiKey);
  }
  for (const [key, value] of Object.entries(configured)) {
    headers[key] = renderMcpHeaderValue(value, apiKey);
  }

  const hasAuthorization = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (!hasAuthorization && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

export async function runToolStep(step, inputs, user) {
  const { mcpServerLabel, toolName } = resolveToolConfig(step);
  const servers = Array.isArray(user?.mcpServers) ? user.mcpServers : [];
  const server = servers.find((row) => String(row?.server_label || '').trim() === mcpServerLabel);

  if (!server) throw new Error(`MCP server "${mcpServerLabel}" not found in your settings`);

  const endpoint = String(server.server_url || '').trim();
  if (!endpoint) throw new Error(`MCP server "${mcpServerLabel}" has no server_url configured`);
  if (!server.apiKeyEnc) throw new Error(`MCP server "${mcpServerLabel}" has no API key configured`);

  const apiKey = await decrypt(server.apiKeyEnc);
  const toolSchema = await getSharedToolSchema(endpoint, toolName);
  const toolArgs = buildToolArguments(inputs, toolSchema);
  const headers = await buildMcpRequestHeaders(server, apiKey);

  const controller = new AbortController();
  const timeoutMs = Number(server.timeoutMs || 30000);
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `waiflo-tool-${Date.now()}`,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: toolArgs
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status} ${response.statusText}`);
    }

    return await parseMcpResponse(response);
  } finally {
    clearTimeout(timer);
  }
}
