import express   from 'express';
import jwt        from 'jsonwebtoken';
import rateLimit  from 'express-rate-limit';
import { authMiddleware } from './auth.js';
import { getUser } from '../lib/users.js';
import { runPromptStep, runApiStep, runWebpageStep } from '../lib/runner.js';
import { PROVIDER_META } from '../lib/providers/index.js';
import { getLatestStepRunRecord, saveStepRunRecord } from '../lib/runStore.js';

const router = express.Router();

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
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
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
    if (!step || !step.ws_name) return res.status(400).json({ error: 'step definition required' });
    const wsType = (step.ws_type || 'prompt').toLowerCase();
    const workflowName = context?.workflowName || 'ad-hoc';
    const nodeId = context?.nodeId || step.ws_name;
    const runMode = context?.runMode || 'step_only';

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
      // Streaming SSE
      const promptRun = await runPromptStep(step, inputs || {}, user, res);
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
          logMeta: promptRun?.error ? 'prompt error' : 'prompt done',
          createdAt: new Date().toISOString()
        });
      }

    } else if (wsType === 'api' || wsType === 'webpage') {
      // Synchronous HTTP
      try {
        const result = wsType === 'webpage'
          ? await runWebpageStep(step, inputs || {})
          : await runApiStep(step, inputs || {});
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
            logMeta: `${wsType} done`,
            createdAt: new Date().toISOString()
          });
        }
        res.json({ ok: true, result });
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
            logMeta: `${wsType} error`,
            createdAt: new Date().toISOString()
          });
        }
        res.status(502).json({ error: err.message });
      }

    } else {
      res.status(400).json({ error: `ws_type "${wsType}" not yet executable from this endpoint` });
    }

  } catch (err) {
    console.error('exec error:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
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
