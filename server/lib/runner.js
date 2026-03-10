import { decrypt } from './crypto.js';
import { createProvider, PROVIDER_META } from './providers/index.js';

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
export async function runPromptStep(step, inputs, user, res) {
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

/**
 * Execute a webpage step (browser-like HTML fetch).
 * Returns { url, status, contentType, html }.
 */
export async function runWebpageStep(step, inputs) {
  const webpageConfig = step.ws_webpage || step.ws_api || {};
  let url = webpageConfig.url || '';

  // Substitute {{input}} variables in URL
  for (const [k, v] of Object.entries(inputs)) {
    url = url.replaceAll(`{{${k}}}`, encodeURI(String(v)));
  }

  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'User-Agent': webpageConfig.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    ...(webpageConfig.headers || {})
  };

  const response = await fetch(url, { method: 'GET', headers, redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} — ${response.statusText} — ${url}`);
  }

  return {
    url: response.url,
    status: response.status,
    contentType: response.headers.get('content-type') || '',
    html: await response.text()
  };
}
