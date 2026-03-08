import Anthropic from '@anthropic-ai/sdk';
import { decrypt } from './crypto.js';

function resolveApiKey(user) {
  if (user.plan === 'self-key' && user.apiKeyEnc) {
    return decrypt(user.apiKeyEnc);
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return process.env.ANTHROPIC_API_KEY;
  }
  throw new Error('No API key available. Set your own key in settings or contact the admin.');
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
  const apiKey = resolveApiKey(user);
  const client = new Anthropic({ apiKey });

  const llm      = step.ws_llm || {};
  const model    = llm.model       || 'claude-sonnet-4-20250514';
  const temp     = llm.temperature ?? 0;
  const maxTok   = llm.max_tokens  || 2048;
  const system   = step.ws_system_prompt || '';

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
    const stream = client.messages.stream({
      model,
      max_tokens: maxTok,
      temperature: temp,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        send('token', { text: chunk.delta.text });
      }
    }

    const final = await stream.finalMessage();
    const fullText = final.content.map(b => b.text || '').join('');

    // Try to parse as JSON
    let parsed = null;
    try {
      const clean = fullText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(clean);
    } catch { /* not JSON */ }

    send('done', { full: fullText, parsed, usage: final.usage });
    res.end();

  } catch (err) {
    send('error', { message: err.message });
    res.end();
  }
}

/**
 * Execute an API step (HTTP GET/POST/etc).
 * Returns { results, total, size } or raw response body.
 */
export async function runApiStep(step, inputs) {
  const apiConfig = step.ws_api || {};
  let url = apiConfig.url || '';

  // Substitute {{input}} variables in URL
  for (const [k, v] of Object.entries(inputs)) {
    url = url.replaceAll(`{{${k}}}`, encodeURI(String(v)));
  }

  const method  = (apiConfig.method || 'GET').toUpperCase();
  const headers = { 'Accept': 'application/json', ...(apiConfig.headers || {}) };

  const fetchOpts = { method, headers };
  if (apiConfig.body && method !== 'GET') {
    fetchOpts.body = JSON.stringify(apiConfig.body);
    headers['Content-Type'] = 'application/json';
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
