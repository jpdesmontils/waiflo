/**
 * Waiflo Design API
 * Routes dédiées à l'édition granulaire — utilisées par l'éditeur UI et l'API publique.
 *
 * POST   /api/workflow/design          — créer un workflow
 * PATCH  /api/workflow/design          — deep merge partiel sur la racine du workflow
 * POST   /api/workflow-step/design     — upsert un step par ws_name
 * PATCH  /api/workflow-step/design     — deep merge partiel sur un step
 * DELETE /api/workflow-step/design     — supprimer un step + nettoyage wf_nodes
 */

import express from 'express';
import fs      from 'fs/promises';
import { authMiddleware } from './auth.js';
import { ensureUserDir } from '../lib/users.js';
import { wfPath } from '../lib/utils.js';

async function readWf(userId, name) {
  const fp  = wfPath(userId, name);
  const raw = await fs.readFile(fp, 'utf8');
  return { fp, data: JSON.parse(raw) };
}

async function writeWf(fp, data) {
  await fs.writeFile(fp, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Deep merge récursif : patch est fusionné dans target.
 * Les tableaux sont remplacés (sauf traitement spécial des steps via les routes).
 */
function deepMerge(target, patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const result = { ...target };
  for (const key of Object.keys(patch)) {
    if (
      typeof patch[key] === 'object' && patch[key] !== null && !Array.isArray(patch[key]) &&
      typeof result[key] === 'object' && result[key] !== null && !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], patch[key]);
    } else {
      result[key] = patch[key];
    }
  }
  return result;
}

function validateStep(step) {
  if (!step || typeof step !== 'object') return 'step must be an object';
  if (!step.ws_name || typeof step.ws_name !== 'string') return 'ws_name (string) is required';
  if (!/^[a-zA-Z0-9_\-]+$/.test(step.ws_name)) return 'ws_name must only contain letters, numbers, _ or -';
  const validTypes = ['prompt', 'api', 'transform', 'script', 'tool'];
  if (step.ws_type && !validTypes.includes(step.ws_type)) {
    return `ws_type must be one of: ${validTypes.join(', ')}`;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
//  WORKFLOW DESIGN  (/api/workflow/design)
// ══════════════════════════════════════════════════════════════════

export const wfRouter = express.Router();
wfRouter.use(authMiddleware);

/**
 * POST /api/workflow/design
 * Crée un nouveau workflow. Refuse si déjà existant (409).
 * Body: { workflow_name, data? }
 */
wfRouter.post('/', async (req, res) => {
  try {
    const { workflow_name, data } = req.body;
    if (!workflow_name) return res.status(400).json({ error: 'workflow_name is required' });

    await ensureUserDir(req.user.userId);
    const fp = wfPath(req.user.userId, workflow_name);

    try {
      await fs.access(fp);
      return res.status(409).json({ error: `Workflow "${workflow_name}" already exists — use PATCH to update` });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // Only ignore "file not found"
    }

    const wfData = data || {};
    if (!wfData.lang_name)                wfData.lang_name  = workflow_name;
    if (!Array.isArray(wfData.steps))     wfData.steps      = [];
    if (!Array.isArray(wfData.workflows)) wfData.workflows   = [];

    await writeWf(fp, wfData);

    res.status(201).json({
      ok: true,
      workflow_name,
      steps_count: wfData.steps.length,
      createdAt: new Date().toISOString()
    });
  } catch (err) {
    console.error('POST /workflow/design:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/workflow/design
 * Deep merge partiel sur la racine du workflow (lang_name, workflows[], etc.)
 * Pour les steps, utiliser /api/workflow-step/design.
 * Body: { workflow_name, patch }
 */
wfRouter.patch('/', async (req, res) => {
  try {
    const { workflow_name, patch } = req.body;
    if (!workflow_name)                   return res.status(400).json({ error: 'workflow_name is required' });
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch (object) is required' });

    const { fp, data } = await readWf(req.user.userId, workflow_name);
    const merged = deepMerge(data, patch);
    await writeWf(fp, merged);

    res.json({
      ok: true,
      workflow_name,
      patched_keys: Object.keys(patch),
      steps_count: (merged.steps || []).length,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    console.error('PATCH /workflow/design:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  WORKFLOW-STEP DESIGN  (/api/workflow-step/design)
// ══════════════════════════════════════════════════════════════════

export const stepRouter = express.Router();
stepRouter.use(authMiddleware);

/**
 * POST /api/workflow-step/design
 * Upsert d'un step complet (add ou replace par ws_name).
 * Body: { workflow_name, step, position? }
 *   - position (0-based) : insère à cet index si nouveau step
 *   - si le ws_name existe déjà → replace in-place
 */
stepRouter.post('/', async (req, res) => {
  try {
    const { workflow_name, step, position } = req.body;
    if (!workflow_name) return res.status(400).json({ error: 'workflow_name is required' });

    const err = validateStep(step);
    if (err) return res.status(400).json({ error: err });

    const { fp, data } = await readWf(req.user.userId, workflow_name);
    const steps = data.steps || [];
    const existingIdx = steps.findIndex(s => s.ws_name === step.ws_name);

    let action;
    if (existingIdx >= 0) {
      steps[existingIdx] = step;
      action = 'replaced';
    } else if (typeof position === 'number') {
      steps.splice(Math.max(0, Math.min(position, steps.length)), 0, step);
      action = 'inserted';
    } else {
      steps.push(step);
      action = 'added';
    }

    data.steps = steps;
    await writeWf(fp, data);

    res.status(existingIdx >= 0 ? 200 : 201).json({
      ok: true,
      workflow_name,
      ws_name: step.ws_name,
      action,
      steps_count: steps.length,
      savedAt: new Date().toISOString()
    });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    console.error('POST /workflow-step/design:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/workflow-step/design
 * Deep merge partiel sur un step existant.
 * Body: { workflow_name, ws_name, patch }
 *
 * Exemples :
 *   Changer le system prompt : { ..., patch: { ws_system_prompt: "..." } }
 *   Changer température :      { ..., patch: { ws_llm: { temperature: 0.7 } } }
 *   Ajouter un input :         { ..., patch: { ws_inputs_schema: { properties: { new_field: { type: "string" } } } } }
 */
stepRouter.patch('/', async (req, res) => {
  try {
    const { workflow_name, ws_name, patch } = req.body;
    if (!workflow_name)                      return res.status(400).json({ error: 'workflow_name is required' });
    if (!ws_name)                            return res.status(400).json({ error: 'ws_name is required' });
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch (object) is required' });
    if (patch.ws_name && patch.ws_name !== ws_name) {
      return res.status(400).json({ error: 'Cannot rename ws_name via PATCH — POST with new step name instead' });
    }

    const { fp, data } = await readWf(req.user.userId, workflow_name);
    const idx = (data.steps || []).findIndex(s => s.ws_name === ws_name);
    if (idx < 0) return res.status(404).json({ error: `Step "${ws_name}" not found in "${workflow_name}"` });

    data.steps[idx] = deepMerge(data.steps[idx], patch);
    await writeWf(fp, data);

    res.json({
      ok: true,
      workflow_name,
      ws_name,
      patched_keys: Object.keys(patch),
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    console.error('PATCH /workflow-step/design:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/workflow-step/design
 * Supprime un step + nettoie les wf_nodes qui le référencent.
 * Body: { workflow_name, ws_name }
 */
stepRouter.delete('/', async (req, res) => {
  try {
    const { workflow_name, ws_name } = req.body;
    if (!workflow_name) return res.status(400).json({ error: 'workflow_name is required' });
    if (!ws_name)       return res.status(400).json({ error: 'ws_name is required' });

    const { fp, data } = await readWf(req.user.userId, workflow_name);
    const before = (data.steps || []).length;
    data.steps   = (data.steps || []).filter(s => s.ws_name !== ws_name);
    if (data.steps.length === before) return res.status(404).json({ error: `Step "${ws_name}" not found` });

    // Nettoyage wf_nodes et depends_on
    (data.workflows || []).forEach(wf => {
      wf.wf_nodes = (wf.wf_nodes || []).filter(n => n.ws_ref !== ws_name);
      wf.wf_nodes.forEach(n => { n.depends_on = (n.depends_on || []).filter(d => d !== ws_name); });
    });

    await writeWf(fp, data);
    res.json({ ok: true, workflow_name, ws_name, deleted: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    res.status(500).json({ error: err.message });
  }
});
