import { getServerConfig } from './configLoader.js';
import { runApiStep, runWebpageStep, runToolStep } from './runner.js';
import { decrypt } from './crypto.js';
import { createProvider, PROVIDER_META } from './providers/index.js';

/**
 * Promise-based semaphore for bounding concurrent step executions.
 */
class Semaphore {
  constructor(max) {
    this._max = max;
    this._active = 0;
    this._waitQueue = [];
  }

  acquire() {
    if (this._active < this._max) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this._waitQueue.push(resolve);
    });
  }

  release() {
    if (this._waitQueue.length > 0) {
      const next = this._waitQueue.shift();
      next();
    } else {
      this._active = Math.max(0, this._active - 1);
    }
  }
}

/**
 * Executes a prompt step without SSE streaming (for background workflow context).
 * Uses the provider's complete() method to get the full response.
 */
async function runPromptStepBackground(stepDef, inputs) {
  const llm      = stepDef.ws_llm || {};
  const provider = (llm.provider || 'anthropic').toLowerCase();
  const meta     = PROVIDER_META[provider] || PROVIDER_META.anthropic;
  const model    = llm.model || meta.defaultModel;
  const temp     = llm.temperature ?? 0;
  const maxTok   = llm.max_tokens || 2048;
  const system   = stepDef.ws_system_prompt || '';

  // Resolve API key - provider key from env (managed/guest) or throw
  let apiKey;
  const envKey = meta ? process.env[meta.envVar] : null;
  if (envKey) {
    apiKey = envKey;
  } else {
    throw new Error(
      `No API key available for provider "${provider}" in background workflow execution.`
    );
  }

  const llmProvider = createProvider(provider, apiKey);
  apiKey = null;

  const allInputs = {
    ...inputs,
    ws_output_schema: JSON.stringify(stepDef.ws_output_schema || {}, null, 2)
  };

  let userPrompt = stepDef.ws_prompt_template || '';
  for (const [k, v] of Object.entries(allInputs)) {
    const val = typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v ?? '');
    userPrompt = userPrompt.replaceAll(`{{{${k}}}}`, val);
    userPrompt = userPrompt.replaceAll(`{{${k}}}`, val);
  }

  const fullText = await llmProvider.complete({
    model,
    system,
    userPrompt,
    imageUrls: [],
    temperature: temp,
    maxTokens: maxTok
  });

  let parsed = null;
  try {
    const clean = fullText
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    parsed = JSON.parse(clean);
  } catch { /* not JSON */ }

  return { fullText, parsed };
}

/**
 * Bounded step execution pool.
 * Uses a semaphore to limit concurrent step executions to max_parallel_steps.
 */
export class StepWorkerPool {
  /**
   * @param {number} maxConcurrent
   */
  constructor(maxConcurrent) {
    this._semaphore = new Semaphore(maxConcurrent);
  }

  /**
   * Execute a step within the pool, respecting the concurrency limit.
   *
   * @param {object} stepDef - step definition (ws_type, ws_llm, ws_api, etc.)
   * @param {object} inputs  - resolved input values
   * @param {object} user    - user record (for tool step MCP auth)
   * @returns {Promise<any>} step result
   */
  async runStep(stepDef, inputs, user) {
    await this._semaphore.acquire();
    try {
      return await this._execute(stepDef, inputs, user);
    } finally {
      this._semaphore.release();
    }
  }

  async _execute(stepDef, inputs, user) {
    const wsType = (stepDef.ws_type || 'prompt').toLowerCase();

    switch (wsType) {
      case 'prompt':
        return runPromptStepBackground(stepDef, inputs || {});

      case 'api':
        return runApiStep(stepDef, inputs || {});

      case 'webpage':
        return runWebpageStep(stepDef, inputs || {});

      case 'tool':
        return runToolStep(stepDef, inputs || {}, user);

      case 'transform':
        return runTransformStep(stepDef, inputs || {});

      case 'script':
        return runScriptStep(stepDef, inputs || {});

      default:
        throw new Error(`Unknown step type: "${wsType}"`);
    }
  }
}

/**
 * Transform step: applies a JSON mapping transformation.
 * Maps output fields from input using JSONPath-like dot notation.
 */
function runTransformStep(stepDef, inputs) {
  const mapping = stepDef.ws_transform?.mapping || {};
  const result = {};
  for (const [outputKey, inputRef] of Object.entries(mapping)) {
    result[outputKey] = resolveRef(inputRef, inputs);
  }
  return result;
}

/**
 * Script step: executes a simple JS expression.
 * NOTE: This uses Function() — only use in trusted server contexts.
 */
function runScriptStep(stepDef, inputs) {
  const code = stepDef.ws_script?.code || '';
  if (!code.trim()) return {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('inputs', code);
  return fn(inputs) || {};
}

function resolveRef(ref, data) {
  if (typeof ref !== 'string') return ref;
  const parts = ref.split('.');
  let val = data;
  for (const part of parts) {
    if (val == null) return undefined;
    val = val[part];
  }
  return val;
}

/** Singleton pool instance. */
const _config = getServerConfig();
export const stepWorkerPool = new StepWorkerPool(_config.max_parallel_steps);
