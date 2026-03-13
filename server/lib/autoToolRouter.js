import { readSharedToolSchemas } from './mcpShared.js';

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function vectorize(text) {
  const tokens = tokenize(text);
  const map = new Map();
  for (const t of tokens) {
    map.set(t, (map.get(t) || 0) + 1);
  }
  return map;
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [k, v] of a.entries()) {
    normA += v * v;
    if (b.has(k)) dot += v * b.get(k);
  }

  for (const v of b.values()) {
    normB += v * v;
  }

  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

let TOOL_INDEX = null;

export async function buildToolIndex() {

  const registry = await readSharedToolSchemas();
  const tools = Object.values(registry.tools || {});

  TOOL_INDEX = tools.map(tool => {

    const text =
      `${tool.tool_name} ${tool.description || ''} ` +
      `${JSON.stringify(tool.inputSchema || {})}`;

    return {
      tool,
      vector: vectorize(text)
    };

  });

  return TOOL_INDEX;
}

export async function resolveAutoTool(prompt, inputs = {}) {

  if (!TOOL_INDEX) {
    await buildToolIndex();
  }

  const promptVec = vectorize(prompt);

  let best = null;
  let bestScore = -1;

  for (const row of TOOL_INDEX) {

    const schema = row.tool.inputSchema || {};
    const required = schema.required || [];

    // skip tools impossible to execute
    const impossible = required.some(r => inputs[r] == null);

    if (impossible) continue;

    const score = cosine(promptVec, row.vector);

    if (score > bestScore) {
      bestScore = score;
      best = row.tool;
    }

  }

  return best;
}

export function buildToolArgumentsFromPrompt(prompt, toolSchema) {

  const schema = toolSchema?.inputSchema || {};
  const props = schema.properties || {};

  const args = {};

  if (props.textQuery) {
    args.textQuery = prompt;
  }

  if (props.query) {
    args.query = prompt;
  }

  if (props.address) {
    args.address = prompt;
  }

  const numberMatch = prompt.match(/\d+/);

  if (props.limit && numberMatch) {
    args.limit = Number(numberMatch[0]);
  }

  if (props.radius && numberMatch) {
    args.radius = Number(numberMatch[0]);
  }

  if (props.mapbox_id && prompt.includes("mapbox_id")) {
    const m = prompt.match(/mapbox_id[:=]\s*([a-zA-Z0-9_\-]+)/);
    if (m) args.mapbox_id = m[1];
  }

  return args;
}