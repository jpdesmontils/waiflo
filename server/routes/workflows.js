import express from 'express';
import fs      from 'fs/promises';
import path    from 'path';
import { authMiddleware } from './auth.js';
import { workflowDir, ensureUserDir } from '../lib/users.js';
import { safeName, wfPath } from '../lib/utils.js';
import { deleteWorkflowRunData, pruneWorkflowRunData } from '../lib/runStore.js';
import { readUserGraphPositions, writeUserGraphPositions, extractWorkflowPositions, applyWorkflowPositions } from '../lib/graphPositions.js';

const router = express.Router();

// All routes require auth
router.use(authMiddleware);

// ── LIST ──────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const dir = workflowDir(req.user.userId);
    await ensureUserDir(req.user.userId);
    const files = await fs.readdir(dir);
    const workflows = await Promise.all(
      files
        .filter(f => f.endsWith('.waiflo.json'))
        .map(async f => {
          const stat = await fs.stat(path.join(dir, f));
          return {
            name: f.replace('.waiflo.json', ''),
            filename: f,
            size: stat.size,
            updatedAt: stat.mtime.toISOString()
          };
        })
    );
    res.json(workflows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  } catch (err) {
    console.error('list error:', err);
    res.status(500).json({ error: 'Failed to list workflows' });
  }
});

// ── GET ───────────────────────────────────────────────────────────
router.get('/:name', async (req, res) => {
  try {
    const fp  = wfPath(req.user.userId, req.params.name);
    const raw = await fs.readFile(fp, 'utf8');
    try {
      const data = JSON.parse(raw);
      const allPositions = await readUserGraphPositions(req.user.userId);
      const workflowPositions = allPositions[req.params.name] || {};
      res.json(applyWorkflowPositions(data, workflowPositions));
    } catch {
      res.status(400).json({ error: 'Workflow file is corrupted (invalid JSON)' });
    }
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    res.status(500).json({ error: 'Failed to read workflow' });
  }
});

// ── CREATE ────────────────────────────────────────────────────────
router.post('/:name', async (req, res) => {
  try {
    await ensureUserDir(req.user.userId);
    const fp = wfPath(req.user.userId, req.params.name);
    // Refuse overwrite on POST
    try {
      await fs.access(fp);
      return res.status(409).json({ error: 'Workflow already exists — use PUT to update' });
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // Only ignore "file not found"
    }
    const body = typeof req.body === 'object' ? JSON.stringify(req.body, null, 2) : req.body;
    await fs.writeFile(fp, body, 'utf8');

    const next = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const allPositions = await readUserGraphPositions(req.user.userId);
    allPositions[req.params.name] = extractWorkflowPositions(next);
    await writeUserGraphPositions(req.user.userId, allPositions);

    res.status(201).json({ ok: true, name: req.params.name });
  } catch (err) {
    console.error('create error:', err);
    res.status(500).json({ error: err.message || 'Failed to create workflow' });
  }
});

// ── UPDATE (save) ─────────────────────────────────────────────────
router.put('/:name', async (req, res) => {
  try {
    await ensureUserDir(req.user.userId);
    const fp   = wfPath(req.user.userId, req.params.name);
    const body = typeof req.body === 'object' ? JSON.stringify(req.body, null, 2) : req.body;
    await fs.writeFile(fp, body, 'utf8');
    const next = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const stepNames = (next.steps || []).map(s => s.ws_name).filter(Boolean);
    await pruneWorkflowRunData(req.user.userId, req.params.name, stepNames);

    const allPositions = await readUserGraphPositions(req.user.userId);
    allPositions[req.params.name] = extractWorkflowPositions(next);
    await writeUserGraphPositions(req.user.userId, allPositions);

    res.json({ ok: true, name: req.params.name, savedAt: new Date().toISOString() });
  } catch (err) {
    console.error('save error:', err);
    res.status(500).json({ error: err.message || 'Failed to save workflow' });
  }
});

// ── RENAME ────────────────────────────────────────────────────────
router.patch('/:name/rename', async (req, res) => {
  try {
    const { newName } = req.body;
    if (!newName) return res.status(400).json({ error: 'newName required' });
    const oldPath = wfPath(req.user.userId, req.params.name);
    const newPath = wfPath(req.user.userId, newName);
    await fs.rename(oldPath, newPath);
    await deleteWorkflowRunData(req.user.userId, req.params.name);

    const allPositions = await readUserGraphPositions(req.user.userId);
    if (Object.prototype.hasOwnProperty.call(allPositions, req.params.name)) {
      allPositions[newName] = allPositions[req.params.name];
      delete allPositions[req.params.name];
      await writeUserGraphPositions(req.user.userId, allPositions);
    }

    res.json({ ok: true, name: newName });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    res.status(500).json({ error: 'Failed to rename workflow' });
  }
});

// ── DELETE ────────────────────────────────────────────────────────
router.delete('/:name', async (req, res) => {
  try {
    const fp = wfPath(req.user.userId, req.params.name);
    await fs.unlink(fp);
    await deleteWorkflowRunData(req.user.userId, req.params.name);

    const allPositions = await readUserGraphPositions(req.user.userId);
    if (Object.prototype.hasOwnProperty.call(allPositions, req.params.name)) {
      delete allPositions[req.params.name];
      await writeUserGraphPositions(req.user.userId, allPositions);
    }

    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    res.status(500).json({ error: 'Failed to delete workflow' });
  }
});

// ── EXPORT (raw download) ─────────────────────────────────────────
router.get('/:name/export', async (req, res) => {
  try {
    const fp  = wfPath(req.user.userId, req.params.name);
    const raw = await fs.readFile(fp, 'utf8');
    const filename = `${safeName(req.params.name)}.waiflo.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Workflow not found' });
    res.status(500).json({ error: 'Failed to export' });
  }
});

export default router;
