import express   from 'express';
import jwt        from 'jsonwebtoken';
import fs         from 'fs/promises';
import { randomUUID } from 'crypto';
import rateLimit  from 'express-rate-limit';
import { authMiddleware } from './auth.js';
import { getUser } from '../lib/users.js';
import { runPromptStep, runApiStep, runWebpageStep, runToolStep } from '../lib/runner.js';
import { PROVIDER_META } from '../lib/providers/index.js';
import { deleteAllRunData, getLatestStepRunRecord, listStepRunRecords, saveStepRunRecord } from '../lib/runStore.js';
import { CACHE_CONFIG } from '../config.js';
import { getCachedStepResult, saveCachedStepResult } from '../lib/stepCacheStore.js';
import { wfPath } from '../lib/utils.js';

const router = express.Router();
const workflowRuns = new Map();
const TOKEN_COOKIE = 'wf_token';

function getTokenFromRequest(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  const cookieHeader = String(req.headers.cookie || '');
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${TOKEN_COOKIE}=`)) continue;
    return decodeURIComponent(trimmed.slice(TOKEN_COOKIE.length + 1));
  }
  return null;
}

function getCallerIp(req) {
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '').trim();
  if (forwarded) return forwarded.split(',')[0].trim();
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

function createRun(userId, workflowName) {
  const runId = randomUUID();
  const run = {
    runId,
    userId,
    workflowName,
    status: 'running',
    createdAt: new Date().toISOString(),
    events: [],
    clients: new Set(),
    cancelRequested: false
  };
  workflowRuns.set(runId, run);
  return run;
}

function pushRunEvent(run, event, data = {}) {
  const payload = {
    run_id: run.runId,
    workflow_name: run.workflowName,
    ts: new Date().toISOString(),
    ...data
  };
  run.events.push({ event, data: payload });
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of run.clients) {
    try { res.write(frame); } catch { /* ignore broken stream */ }
  }
}

function attachRunClient(run, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  run.events.forEach(({ event, data }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });

  run.clients.add(res);
  res.on('close', () => run.clients.delete(res));
}

function validateInputValue(value, schema = {}, path = 'inputs') {
  const errors = [];
  const type = schema?.type;

  const fail = (msg) => errors.push(`${path}: ${msg}`);

  if (value == null) return errors;

  if (type === 'string' && typeof value !== 'string') fail('must be a string');
  else if (type === 'number' && (typeof value !== 'number' || Number.isNaN(value))) fail('must be a number');
  else if (type === 'integer' && !Number.isInteger(value)) fail('must be an integer');
  else if (type === 'boolean' && typeof value !== 'boolean') fail('must be a boolean');
  else if (type === 'object' && (typeof value !== 'object' || Array.isArray(value))) fail('must be an object');
  else if (type === 'array' && !Array.isArray(value)) fail('must be an array');
  else if (type === 'image_url') {
    if (typeof value !== 'string') fail('must be an URL string for type image_url');
    else {
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) fail('must use http:// or https://');
      } catch {
        fail('must be a valid URL');
      }
    }
  }

  if (!errors.length && typeof value === 'string') {
    if (schema.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      fail('must match format email');
    } else if (schema.format === 'uri') {
      try { new URL(value); } catch { fail('must match format uri'); }
    } else if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) {
      fail('must match format date-time');
    } else if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      fail('must match format date (YYYY-MM-DD)');
    }
  }

  if (Array.isArray(value) && schema?.items && typeof schema.items === 'object') {
    value.forEach((item, index) => {
      errors.push(...validateInputValue(item, schema.items, `${path}[${index}]`));
    });
  }

  return errors;
}

function validateInputsAgainstSchema(step, inputs) {
  const schema = step?.ws_inputs_schema;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];

  const safeInputs = (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) ? inputs : {};
  const properties = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  const errors = [];
  for (const key of required) {
    if (safeInputs[key] == null || safeInputs[key] === '') {
      errors.push(`inputs.${key}: is required`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(safeInputs)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        errors.push(`inputs.${key}: is not allowed by ws_inputs_schema`);
      }
    }
  }

  for (const [key, value] of Object.entries(safeInputs)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    errors.push(...validateInputValue(value, properties[key], `inputs.${key}`));
  }

  return errors;
}

function inferSchemaFromValue(value) {
  if (Array.isArray(value)) {
    if (!value.length) return { type: 'array', items: {} };
    return { type: 'array', items: inferSchemaFromValue(value[0]) };
  }
  if (value == null) return { type: 'null' };
  if (typeof value === 'object') {
    const properties = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      properties[key] = inferSchemaFromValue(nestedValue);
    }
    return { type: 'object', properties };
  }
  if (typeof value === 'number' && Number.isInteger(value)) return { type: 'integer' };
  return { type: typeof value };
}

function buildSchemaMismatchContext(step, inputs) {
  return {
    expected_schema: step?.ws_inputs_schema || null,
    received_schema: inferSchemaFromValue(inputs)
  };
}

function normalizeErrorDetails(err) {
  if (!err) return null;
  const causes = [];
  let cursor = err;
  while (cursor) {
    causes.push({
      name: cursor.name || 'Error',
      message: cursor.message || String(cursor),
      code: cursor.code || null
    });
    cursor = cursor.cause;
  }

  return {
    name: err.name || 'Error',
    message: err.message || String(err),
    code: err.code || null,
    causes
  };
}

function shouldUsePromptCache(wsType) {
  if (!CACHE_CONFIG.enabled) return false;
  if (CACHE_CONFIG.cachePromptOnly) return wsType === 'prompt';
  return true;
}

function cacheMetaFromStep(step) {
  const llm = step?.ws_llm || {};
  return {
    provider: llm.provider || 'anthropic',
    model: llm.model || null
  };
}

function cacheKeyParamsFromStep(step) {
  return {
    promptTemplate: step?.ws_prompt_template || '',
    systemPrompt: step?.ws_system_prompt || '',
    outputSchema: step?.ws_output_schema || {}
  };
}

function promptStreamEnabled(req) {
  const queryStream = req?.query?.stream;
  return !(queryStream === '0' || queryStream === 'false');
}

function sendPromptCacheResponse(req, res, output) {
  const stream = promptStreamEnabled(req);
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(`event: done\n`);
    res.write(`data: ${JSON.stringify({ full: typeof output === 'string' ? output : JSON.stringify(output), parsed: output, cache_hit: true })}\n\n`);
    res.end();
    return;
  }
  res.json({ ok: true, full: typeof output === 'string' ? output : JSON.stringify(output), parsed: output, cache_hit: true });
}

async function executeResolvedStep(req, res, { step, inputs, context }) {
  if (!step || !step.ws_name) return res.status(400).json({ error: 'step definition required' });

  const validationErrors = validateInputsAgainstSchema(step, inputs);
  if (validationErrors.length) {
    return res.status(422).json({
      error: 'Inputs do not match ws_inputs_schema',
      details: validationErrors,
      ...buildSchemaMismatchContext(step, inputs)
    });
  }

  const wsType = (step.ws_type || 'prompt').toLowerCase();
  const workflowName = context?.workflowName || 'ad-hoc';
  const nodeId = context?.nodeId || step.ws_name;
  const runMode = context?.runMode || 'step_only';
  const callerIp = getCallerIp(req);
  const executionId = randomUUID();

  // Resolve user — guest fallback if no auth
  let user = null;
  if (req.user?.userId) {
    user = await getUser(req.user.userId);
  }
  if (!user) {
    // Guest: only prompt steps require an LLM API key.
    if (wsType === 'prompt') {
      const provider = (step.ws_llm?.provider || 'anthropic').toLowerCase();
      const meta = PROVIDER_META[provider];
      const envKey = meta ? process.env[meta.envVar] : null;
      if (!envKey) {
        return res.status(401).json({
          error: `No API key available for provider "${provider}". Create an account and add your key in Settings → API Keys.`
        });
      }
    }
    user = { plan: 'guest', apiKeyEnc: null, providerKeys: {} };
  }

  if (wsType === 'prompt') {
    let cacheHit = false;
    let cacheKey = null;
    let promptRun = null;

    if (shouldUsePromptCache(wsType)) {
      const cached = await getCachedStepResult({
        userId: req.user?.userId || 'guest',
        workflowName,
        stepName: step.ws_name,
        wsType,
        inputs: inputs || {},
        keyParams: cacheKeyParamsFromStep(step)
      });

      if (cached.hit) {
        cacheHit = true;
        cacheKey = cached.key;
        promptRun = {
          fullText: typeof cached.output === 'string' ? cached.output : JSON.stringify(cached.output),
          parsed: cached.output,
          userPrompt: '',
          error: null
        };
        sendPromptCacheResponse(req, res, cached.output);
      }
    }

    if (!cacheHit) {
      // Streaming SSE
      req.promptDumpContext = {
        userId: req.user?.userId || 'guest',
        workflowName,
        stepName: step.ws_name,
        executionId
      };
      promptRun = await runPromptStep(step, inputs || {}, user, req, res);

      if (!promptRun?.error && shouldUsePromptCache(wsType)) {
        const saved = await saveCachedStepResult({
          userId: req.user?.userId || 'guest',
          workflowName,
          stepName: step.ws_name,
          wsType,
          inputs: inputs || {},
          output: promptRun?.parsed || promptRun?.fullText || '',
          meta: cacheMetaFromStep(step),
          keyParams: cacheKeyParamsFromStep(step)
        });
        cacheKey = saved.key;
      }
    }

    if (req.user?.userId) {
      await saveStepRunRecord(req.user.userId, workflowName, step.ws_name, {
        workflowName,
        nodeId,
        stepName: step.ws_name,
        wsType,
        runMode,
        inputs: inputs || {},
        status: promptRun?.error ? 'error' : (promptRun?.parsed ? 'done' : 'done_raw'),
        logOutput: promptRun?.error || promptRun?.fullText || '',
        output: promptRun?.parsed || promptRun?.fullText || '',
        prompt: promptRun?.userPrompt || '',
        promptDumpPath: promptRun?.promptDumpPath || '',
        callerIp,
        logMeta: promptRun?.error
          ? 'prompt error'
          : (cacheHit ? `prompt done (cache hit ${cacheKey || ''})`.trim() : `prompt done${cacheKey ? ` (cache store ${cacheKey})` : ''}`),
        createdAt: new Date().toISOString()
      });
    }

    return;
  }

  if (wsType === 'api' || wsType === 'webpage' || wsType === 'tool') {
    // Synchronous HTTP
    try {
      let result;
      if (wsType === 'webpage') result = await runWebpageStep(step, inputs || {});
      else if (wsType === 'tool') result = await runToolStep(step, inputs || {}, user);
      else result = await runApiStep(step, inputs || {});
      if (req.user?.userId) {
        await saveStepRunRecord(req.user.userId, workflowName, step.ws_name, {
          workflowName,
          nodeId,
          stepName: step.ws_name,
          wsType,
          runMode,
          inputs: inputs || {},
          status: 'done',
          logOutput: JSON.stringify(result, null, 2),
          output: result,
          prompt: '',
          promptDumpPath: '',
          callerIp,
          logMeta: `${wsType} done`,
          createdAt: new Date().toISOString()
        });
      }
      return res.json({ ok: true, result });
    } catch (err) {
      if (req.user?.userId) {
        await saveStepRunRecord(req.user.userId, workflowName, step.ws_name, {
          workflowName,
          nodeId,
          stepName: step.ws_name,
          wsType,
          runMode,
          inputs: inputs || {},
          status: 'error',
          logOutput: err.message,
          output: '',
          prompt: '',
          promptDumpPath: '',
          callerIp,
          logMeta: `${wsType} error`,
          createdAt: new Date().toISOString()
        });
      }
      return res.status(502).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `ws_type "${wsType}" not yet executable from this endpoint` });
}

function buildWorkflowGraph(workflowData) {
  const wf = (workflowData?.workflows || []).find((row) => Array.isArray(row?.wf_nodes) && row.wf_nodes.length);
  const nodes = wf?.wf_nodes || [];
  const byId = new Map(nodes.map((n) => [n.step_id, n]));
  const children = new Map(nodes.map((n) => [n.step_id, []]));

  nodes.forEach((node) => {
    (node.depends_on || []).forEach((depId) => {
      if (children.has(depId)) children.get(depId).push(node.step_id);
    });
  });

  return { wf, nodes, byId, children };
}

function getDownstreamOrderFromGraph(graph, startNodeId) {
  const { byId, children } = graph;
  if (!byId.has(startNodeId)) return [];

  const included = new Set();
  const stack = [startNodeId];
  while (stack.length) {
    const id = stack.pop();
    if (!id || included.has(id)) continue;
    included.add(id);
    (children.get(id) || []).forEach((childId) => stack.push(childId));
  }

  const indeg = new Map();
  included.forEach((id) => indeg.set(id, 0));
  included.forEach((id) => {
    const node = byId.get(id);
    (node?.depends_on || []).forEach((depId) => {
      if (included.has(depId)) indeg.set(id, (indeg.get(id) || 0) + 1);
    });
  });

  const queue = [...included].filter((id) => indeg.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    (children.get(id) || []).forEach((childId) => {
      if (!included.has(childId)) return;
      indeg.set(childId, (indeg.get(childId) || 0) - 1);
      if (indeg.get(childId) === 0) queue.push(childId);
    });
  }
  return order;
}

async function executeStepForWorkflowRun(step, inputs, req, user) {
  const wsType = (step.ws_type || 'prompt').toLowerCase();
  const workflowName = req?.workflowNameForRun || 'ad-hoc';

  if (wsType === 'prompt') {
    if (shouldUsePromptCache(wsType)) {
      const cached = await getCachedStepResult({
        userId: req.user?.userId || 'guest',
        workflowName,
        stepName: step.ws_name,
        wsType,
        inputs: inputs || {},
        keyParams: cacheKeyParamsFromStep(step)
      });
      if (cached.hit) return { result: cached.output, prompt: '', promptDumpPath: '' };
    }

    const executionId = randomUUID();
    const fakeReq = {
      query: {},
      user: req.user,
      promptDumpContext: {
        userId: req.user?.userId || 'guest',
        workflowName,
        stepName: step.ws_name,
        executionId
      }
    };
    const fakeRes = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key] = value; },
      write() {},
      end() {},
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return payload; }
    };
    const promptRun = await runPromptStep(step, inputs || {}, user, fakeReq, fakeRes);
    if (promptRun?.error) throw new Error(promptRun.error);
    const result = promptRun?.parsed || promptRun?.fullText || '';

    if (shouldUsePromptCache(wsType)) {
      await saveCachedStepResult({
        userId: req.user?.userId || 'guest',
        workflowName,
        stepName: step.ws_name,
        wsType,
        inputs: inputs || {},
        output: result,
        meta: cacheMetaFromStep(step),
        keyParams: cacheKeyParamsFromStep(step)
      });
    }

    return {
      result,
      prompt: promptRun?.userPrompt || '',
      promptDumpPath: promptRun?.promptDumpPath || ''
    };
  }

  if (wsType === 'webpage') return { result: await runWebpageStep(step, inputs || {}), prompt: '', promptDumpPath: '' };
  if (wsType === 'tool') return { result: await runToolStep(step, inputs || {}, user), prompt: '', promptDumpPath: '' };
  if (wsType === 'api') return { result: await runApiStep(step, inputs || {}), prompt: '', promptDumpPath: '' };
  throw new Error(`ws_type "${wsType}" not supported in workflow run`);
}

function buildInputsFromDependencies(node, byId, outputsByNodeId, triggerInputs) {
  const inherited = {};

  (node.depends_on || []).forEach((depId) => {
    const depNode = byId.get(depId);
    const depOutput = outputsByNodeId[depId];
    if (!depNode || !depOutput || typeof depOutput !== 'object') return;
    Object.assign(inherited, depOutput);
  });

  return { ...inherited, ...(triggerInputs || {}) };
}

async function runWorkflowOrchestration(req, run, workflowData, fromStepId, triggerInputs) {
  const graph = buildWorkflowGraph(workflowData);
  const order = getDownstreamOrderFromGraph(graph, fromStepId);
  const stepMap = new Map((workflowData?.steps || []).map((step) => [step.ws_name, step]));
  const outputsByNodeId = {};
  const user = await getUser(req.user.userId);
  let lastFinishedStep = null;
  req.workflowNameForRun = run.workflowName;

  pushRunEvent(run, 'workflow_started', { from_step_id: fromStepId, total_steps: order.length });

  for (const nodeId of order) {
    if (run.cancelRequested) {
      run.status = 'stopped';
      pushRunEvent(run, 'workflow_finished', { status: 'stopped', reason: 'cancel_requested' });
      return;
    }

    const node = graph.byId.get(nodeId);
    if (!node) continue;
    const step = stepMap.get(node.ws_ref);
    if (!step) {
      pushRunEvent(run, 'step_finished', {
        step_id: nodeId,
        ws_ref: node.ws_ref,
        step_desc: '',
        status: 'error',
        error: `Step "${node.ws_ref}" not found`
      });
      run.status = 'error';
      pushRunEvent(run, 'workflow_finished', { status: 'error' });
      return;
    }

    const mergedInputs = buildInputsFromDependencies(node, graph.byId, outputsByNodeId, triggerInputs);
    const validationErrors = validateInputsAgainstSchema(step, mergedInputs);
    pushRunEvent(run, 'step_started', {
      step_id: nodeId,
      ws_ref: node.ws_ref,
      step_desc: step.step_desc || '',
      inputs: mergedInputs
    });

    if (validationErrors.length) {
      pushRunEvent(run, 'step_finished', {
        step_id: nodeId,
        ws_ref: node.ws_ref,
        step_desc: step.step_desc || '',
        status: 'error',
        error: 'Inputs do not match ws_inputs_schema',
        details: validationErrors,
        ...buildSchemaMismatchContext(step, mergedInputs)
      });
      run.status = 'error';
      pushRunEvent(run, 'workflow_finished', { status: 'error' });
      return;
    }

    try {
      const execution = await executeStepForWorkflowRun(step, mergedInputs, req, user);
      const result = execution?.result;
      outputsByNodeId[nodeId] = result;

      await saveStepRunRecord(req.user.userId, run.workflowName, step.ws_name, {
        workflowName: run.workflowName,
        nodeId,
        stepName: step.ws_name,
        wsType: (step.ws_type || 'prompt').toLowerCase(),
        runMode: 'workflow_from_here',
        inputs: mergedInputs,
        status: 'done',
        logOutput: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        output: result,
        prompt: execution?.prompt || '',
        promptDumpPath: execution?.promptDumpPath || '',
        callerIp: getCallerIp(req),
        logMeta: {
          source: 'workflow-run',
          runId: run.runId
        },
        createdAt: new Date().toISOString()
      });

      pushRunEvent(run, 'step_finished', {
        step_id: nodeId,
        ws_ref: node.ws_ref,
        step_desc: step.step_desc || '',
        status: 'done',
        output: result
      });
      lastFinishedStep = {
        step_id: nodeId,
        ws_ref: node.ws_ref,
        step_desc: step.step_desc || '',
        status: 'done',
        output: result
      };
    } catch (err) {
      await saveStepRunRecord(req.user.userId, run.workflowName, step.ws_name, {
        workflowName: run.workflowName,
        nodeId,
        stepName: step.ws_name,
        wsType: (step.ws_type || 'prompt').toLowerCase(),
        runMode: 'workflow_from_here',
        inputs: mergedInputs,
        status: 'error',
        logOutput: err.message,
        output: '',
        prompt: '',
        promptDumpPath: '',
        callerIp: getCallerIp(req),
        logMeta: {
          source: 'workflow-run',
          runId: run.runId
        },
        createdAt: new Date().toISOString()
      });

      pushRunEvent(run, 'step_finished', {
        step_id: nodeId,
        ws_ref: node.ws_ref,
        step_desc: step.step_desc || '',
        status: 'error',
        error: err.message,
        error_details: normalizeErrorDetails(err)
      });
      run.status = 'error';
      pushRunEvent(run, 'workflow_finished', { status: 'error' });
      return;
    }
  }

  run.status = 'done';
  pushRunEvent(run, 'workflow_finished', {
    status: 'done',
    steps_done: Object.keys(outputsByNodeId).length,
    last_step: lastFinishedStep
  });
}

// ── Rate limiting: 30 executions per minute per IP ────────────────
const execLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Optional auth: attaches req.user if Bearer token is valid, continues regardless.
router.use((req, res, next) => {
  const token = getTokenFromRequest(req);
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET); } catch { /* guest */ }
  }
  next();
});

// ── EXEC STEP — streaming SSE ──────────────────────────────────────
// Body: { step: <step_def>, inputs: { key: value, ... } }
router.post('/step', execLimiter, async (req, res) => {
  try {
    const { step, inputs, context } = req.body;
    await executeResolvedStep(req, res, { step, inputs, context });

  } catch (err) {
    console.error('exec error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── EXEC STEP BY REFERENCE ───────────────────────────────────────
// Path: /api/exec/workflows/:workflowName/step
// Body: { ws_ref, step_id, inputs }
router.post('/workflows/:workflowName/step', authMiddleware, execLimiter, async (req, res) => {
  try {
    const workflowName = String(req.params.workflowName || '').trim();
    const { ws_ref, step_id, inputs } = req.body || {};

    if (!workflowName) return res.status(400).json({ error: 'workflowName is required in path' });
    if (!ws_ref || typeof ws_ref !== 'string') return res.status(400).json({ error: 'ws_ref (string) is required' });
    if (!step_id || typeof step_id !== 'string') return res.status(400).json({ error: 'step_id (string) is required' });

    let workflow;
    try {
      const raw = await fs.readFile(wfPath(req.user.userId, workflowName), 'utf8');
      workflow = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: `Workflow "${workflowName}" not found` });
      throw err;
    }

    const node = (workflow.workflows || [])
      .flatMap((wf) => wf?.wf_nodes || [])
      .find((n) => n?.step_id === step_id);

    if (!node) return res.status(404).json({ error: `step_id "${step_id}" not found in workflow` });
    if (node.ws_ref !== ws_ref) {
      return res.status(400).json({
        error: `step_id "${step_id}" is linked to ws_ref "${node.ws_ref}", not "${ws_ref}"`
      });
    }

    const step = (workflow.steps || []).find((entry) => entry?.ws_name === ws_ref);
    if (!step) {
      return res.status(404).json({ error: `Step "${ws_ref}" not found in workflow steps` });
    }

    await executeResolvedStep(req, res, {
      step,
      inputs,
      context: {
        workflowName,
        nodeId: step_id,
        runMode: 'step_only'
      }
    });
  } catch (err) {
    console.error('exec by reference error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ── EXEC WORKFLOW (orchestrated by backend) ──────────────────────
// POST /api/exec/workflows/:workflowName/run
// Body: { from_step_id, inputs }
router.post('/workflows/:workflowName/run', authMiddleware, execLimiter, async (req, res) => {
  try {
    const workflowName = String(req.params.workflowName || '').trim();
    const fromStepId = String(req.body?.from_step_id || '').trim();
    const triggerInputs = (req.body?.inputs && typeof req.body.inputs === 'object' && !Array.isArray(req.body.inputs))
      ? req.body.inputs
      : {};

    if (!workflowName) return res.status(400).json({ error: 'workflowName is required in path' });
    if (!fromStepId) return res.status(400).json({ error: 'from_step_id is required' });

    let workflowData;
    try {
      const raw = await fs.readFile(wfPath(req.user.userId, workflowName), 'utf8');
      workflowData = JSON.parse(raw);
    } catch (err) {
      if (err.code === 'ENOENT') return res.status(404).json({ error: `Workflow "${workflowName}" not found` });
      throw err;
    }

    const graph = buildWorkflowGraph(workflowData);
    if (!graph.byId.has(fromStepId)) {
      return res.status(404).json({ error: `from_step_id "${fromStepId}" not found in workflow` });
    }

    const run = createRun(req.user.userId, workflowName);
    res.status(202).json({ ok: true, run_id: run.runId, status: run.status });

    runWorkflowOrchestration(req, run, workflowData, fromStepId, triggerInputs)
      .catch((err) => {
        run.status = 'error';
        pushRunEvent(run, 'workflow_finished', {
          status: 'error',
          error: err.message,
          error_details: normalizeErrorDetails(err)
        });
      })
      .finally(() => {
        setTimeout(() => {
          const current = workflowRuns.get(run.runId);
          if (current && current.clients.size === 0) workflowRuns.delete(run.runId);
        }, 5 * 60 * 1000);
      });
  } catch (err) {
    console.error('workflow run start error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.get('/runs/:runId/stream', authMiddleware, async (req, res) => {
  const runId = String(req.params.runId || '').trim();
  const run = workflowRuns.get(runId);
  if (!run || run.userId !== req.user.userId) return res.status(404).json({ error: 'Run not found' });
  attachRunClient(run, res);
});

router.post('/runs/:runId/stop', authMiddleware, async (req, res) => {
  const runId = String(req.params.runId || '').trim();
  const run = workflowRuns.get(runId);
  if (!run || run.userId !== req.user.userId) return res.status(404).json({ error: 'Run not found' });
  run.cancelRequested = true;
  res.json({ ok: true, run_id: runId, status: 'stopping' });
});

router.get('/history/latest', authMiddleware, async (req, res) => {
  try {
    const workflowName = req.query.workflow;
    const stepName = req.query.step;
    if (!workflowName || !stepName) return res.status(400).json({ error: 'workflow and step are required' });
    const record = await getLatestStepRunRecord(req.user.userId, workflowName, stepName);
    res.json({ ok: true, record });
  } catch (err) {
    if (err.code === 'ENOENT') return res.json({ ok: true, record: null });
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/logs', authMiddleware, async (req, res) => {
  try {
    const workflowName = String(req.query.workflow || '').trim();
    const logs = await listStepRunRecords(req.user.userId, {
      workflowName: workflowName || null
    });
    res.json({ ok: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/history/prompt-dump', authMiddleware, async (req, res) => {
  try {
    const dumpPath = String(req.query.path || '').trim();
    if (!dumpPath) return res.status(400).json({ error: 'path is required' });
    if (dumpPath.includes('..')) return res.status(400).json({ error: 'invalid path' });

    const safePrefix = `runs/${req.user.userId}/`;
    if (!dumpPath.startsWith(safePrefix)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const dataDir = process.env.DATA_DIR || './waiflo-data';
    const absPath = `${dataDir}/${dumpPath}`;
    const content = await fs.readFile(absPath, 'utf8');
    res.json({ ok: true, path: dumpPath, content });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'prompt dump not found' });
    res.status(500).json({ error: err.message });
  }
});

// ── VALIDATE — parse JSON output from LLM text ────────────────────
router.post('/validate', authMiddleware, (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const clean = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ ok: true, parsed });
  } catch (err) {
    res.status(422).json({ ok: false, error: 'Not valid JSON: ' + err.message });
  }
});

export default router;
