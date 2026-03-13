import express from 'express';
import fs      from 'fs/promises';
import path    from 'path';
import { authMiddleware } from './auth.js';
import { cQueue_management } from '../lib/queue/cQueue_management.js';

const router  = express.Router();
const DATA_DIR   = process.env.DATA_DIR || './waiflo-data';
const QUEUE_ROOT = path.join(DATA_DIR, 'file_queues');

/**
 * POST /api/exec/workflow
 *
 * Enqueue a workflow execution request.
 *
 * Body:
 *   {
 *     workflow_id: string,   // name of the workflow (without .waiflo.json extension)
 *     inputs: object,        // workflow input values
 *     max_retry: number      // optional, default 3
 *   }
 *
 * Response 202:
 *   { ok: true, job_id: string, workflow_id: string }
 */
router.post('/workflow', authMiddleware, async (req, res) => {
  try {
    const { workflow_id, inputs, max_retry } = req.body || {};
    const userId = req.user.userId;

    if (!workflow_id || typeof workflow_id !== 'string') {
      return res.status(400).json({ error: 'workflow_id is required' });
    }

    // Validate workflow exists for this user
    const workflowPath = path.join(DATA_DIR, 'workflows', userId, `${workflow_id}.waiflo.json`);
    try {
      await fs.access(workflowPath);
    } catch {
      return res.status(404).json({ error: `Workflow "${workflow_id}" not found` });
    }

    const queue = new cQueue_management(QUEUE_ROOT, userId, workflow_id);

    const job = {
      workflow_id,
      user_id: userId,
      inputs: inputs || {},
      created_at: new Date().toISOString(),
      retry: 0,
      max_retry: typeof max_retry === 'number' ? max_retry : 3
    };

    const filename = await queue.enqueue(job);

    return res.status(202).json({
      ok: true,
      job_id: filename,
      workflow_id
    });

  } catch (err) {
    console.error('[execWorkflow] enqueue error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/exec/workflow/:jobId/status
 *
 * Check the status of a queued or completed workflow job.
 * Requires query param: workflow_id
 *
 * Response:
 *   { ok: true, job_id: string, status: 'queued'|'processing'|'done'|'failed'|'retrying'|'not_found' }
 */
router.get('/workflow/:jobId/status', authMiddleware, async (req, res) => {
  try {
    const { jobId } = req.params;
    const { workflow_id } = req.query;
    const userId = req.user.userId;

    if (!workflow_id) {
      return res.status(400).json({ error: 'workflow_id query parameter is required' });
    }

    const queue = new cQueue_management(QUEUE_ROOT, userId, workflow_id);
    const location = await queue.getJobStatus(jobId);

    const statusMap = {
      queue:       'queued',
      processing:  'processing',
      exec_ok:     'done',
      exec_ko:     'failed',
      retry_queue: 'retrying'
    };

    if (!location) {
      return res.json({ ok: true, job_id: jobId, status: 'not_found' });
    }

    const status = statusMap[location] || location;

    // If done, also return the result if available
    let result = null;
    if (location === 'exec_ok') {
      const base = jobId.replace(/\.json$/, '');
      const resultPath = path.join(queue.dirs.exec_ok, `${base}.result.json`);
      try {
        const raw = await fs.readFile(resultPath, 'utf8');
        result = JSON.parse(raw);
      } catch { /* result file may not exist yet */ }
    }

    return res.json({ ok: true, job_id: jobId, status, result });

  } catch (err) {
    console.error('[execWorkflow] status error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
