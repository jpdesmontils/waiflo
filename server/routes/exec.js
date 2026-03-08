import express from 'express';
import jwt              from 'jsonwebtoken';
import { authMiddleware } from './auth.js';
import { getUser } from '../lib/users.js';
import { runPromptStep, runApiStep } from '../lib/runner.js';

const router = express.Router();

// Optional auth: attaches req.user if Bearer token is valid, continues regardless.
router.use((req, res, next) => {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try { req.user = jwt.verify(token, process.env.JWT_SECRET || 'change-me'); } catch { /* guest */ }
  }
  next();
});

// ── EXEC STEP — streaming SSE ──────────────────────────────────────
// Body: { step: <step_def>, inputs: { key: value, ... } }
router.post('/step', async (req, res) => {
  try {
    const { step, inputs } = req.body;
    if (!step || !step.ws_name) return res.status(400).json({ error: 'step definition required' });

    // Resolve user — guest fallback if no auth
    let user = null;
    if (req.user?.userId) {
      user = await getUser(req.user.userId);
    }
    if (!user) {
      // Guest: runner will fall back to process.env.ANTHROPIC_API_KEY
      if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(401).json({ error: 'No API key available. Create an account and add your Anthropic key in Settings.' });
      }
      user = { plan: 'guest', apiKeyEnc: null };
    }

    const wsType = (step.ws_type || 'prompt').toLowerCase();

    if (wsType === 'prompt') {
      // Streaming SSE
      await runPromptStep(step, inputs || {}, user, res);

    } else if (wsType === 'api') {
      // Synchronous HTTP
      try {
        const result = await runApiStep(step, inputs || {});
        res.json({ ok: true, result });
      } catch (err) {
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