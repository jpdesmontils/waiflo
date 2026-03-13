import fs from 'fs/promises';
import path from 'path';
import { getServerConfig } from './configLoader.js';
import { getUserMaxParallel } from './pricePlanLoader.js';
import { concurrencyManager } from './concurrency.js';
import { cQueue_management } from './queue/cQueue_management.js';
import { workflowExecutor } from './workflowExecutor.js';
import { getUser } from './users.js';

const DATA_DIR    = process.env.DATA_DIR || './waiflo-data';
const QUEUE_ROOT  = path.join(DATA_DIR, 'file_queues');
const POLL_INTERVAL_MS = 500;

/**
 * Workflow scheduler.
 *
 * - Polls all user queue directories every 500ms
 * - Respects global and per-user concurrency limits
 * - Dispatches eligible jobs to WorkflowExecutor
 * - Handles crash recovery: moves stale processing/ files back to queue/ on startup
 * - Re-queues retry_queue/ jobs on each poll tick
 */
export class WorkflowScheduler {
  constructor() {
    this._timer = null;
    this._running = false;
  }

  /**
   * Start the scheduler. Performs crash recovery first, then begins polling.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    console.log('[scheduler] Starting workflow scheduler...');
    await this._recoverStalJobs();
    this._timer = setInterval(() => {
      this._tick().catch(err => console.error('[scheduler] tick error:', err));
    }, POLL_INTERVAL_MS);
    console.log('[scheduler] Scheduler started.');
  }

  /**
   * Stop the scheduler.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    console.log('[scheduler] Stopped.');
  }

  // ── Crash recovery ─────────────────────────────────────────────────

  /**
   * On startup, move any jobs stuck in processing/ back to queue/.
   * This handles the case where the server crashed mid-execution.
   */
  async _recoverStalJobs() {
    try {
      const userIds = await this._listDir(QUEUE_ROOT);
      for (const userId of userIds) {
        const userDir = path.join(QUEUE_ROOT, userId);
        const workflowIds = await this._listDir(userDir);
        for (const workflowId of workflowIds) {
          const queue = new cQueue_management(QUEUE_ROOT, userId, workflowId);
          const stale = await queue.getProcessingJobs();
          for (const { filename } of stale) {
            try {
              await fs.rename(
                path.join(QUEUE_ROOT, userId, workflowId, 'processing', filename),
                path.join(QUEUE_ROOT, userId, workflowId, 'queue', filename)
              );
              console.log(`[scheduler] Recovered stale job: ${userId}/${workflowId}/${filename}`);
            } catch (err) {
              console.warn(`[scheduler] Could not recover stale job ${filename}:`, err.message);
            }
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn('[scheduler] Crash recovery scan error:', err.message);
      }
    }
  }

  // ── Poll tick ──────────────────────────────────────────────────────

  async _tick() {
    const config = getServerConfig();
    const maxGlobal = config.max_parallel_workflows_global;

    // Quick bail if global limit reached
    if (concurrencyManager.getActiveGlobal() >= maxGlobal) return;

    try {
      const userIds = await this._listDir(QUEUE_ROOT);
      for (const userId of userIds) {
        await this._processUser(userId, maxGlobal);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('[scheduler] scan error:', err.message);
      }
    }
  }

  async _processUser(userId, maxGlobal) {
    const user = await getUser(userId).catch(() => null);
    const maxForUser = getUserMaxParallel(user || { plan: null });

    // Check per-user limit before scanning workflows
    if (!concurrencyManager.canRun(userId, maxGlobal, maxForUser)) return;

    const userDir = path.join(QUEUE_ROOT, userId);
    const workflowIds = await this._listDir(userDir);

    for (const workflowId of workflowIds) {
      // Re-check limits in inner loop (may have changed from earlier iterations)
      if (!concurrencyManager.canRun(userId, maxGlobal, maxForUser)) break;

      const queue = new cQueue_management(QUEUE_ROOT, userId, workflowId);

      // Move retry_queue/ jobs back to queue/ so they get picked up
      await this._flushRetryQueue(queue);

      const next = await queue.dequeue();
      if (!next) continue;

      const { filename, job } = next;

      // Atomically claim the job
      try {
        await queue.moveToProcessing(filename);
      } catch (err) {
        // Another process may have claimed it (race condition — safe to skip)
        console.warn(`[scheduler] Could not move ${filename} to processing:`, err.message);
        continue;
      }

      concurrencyManager.acquire(userId);

      // Fire-and-forget: do not await
      this._executeJob(queue, filename, job, user).catch(err => {
        console.error(`[scheduler] Unexpected error in _executeJob for ${filename}:`, err);
      });
    }
  }

  /**
   * Move all retry_queue/ files back to queue/ so they participate in the next poll.
   */
  async _flushRetryQueue(queue) {
    try {
      let retryFiles;
      try {
        retryFiles = await fs.readdir(queue.dirs.retry_queue);
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const filename of retryFiles) {
        if (!filename.endsWith('.json')) continue;
        try {
          await fs.rename(
            path.join(queue.dirs.retry_queue, filename),
            path.join(queue.dirs.queue, filename)
          );
        } catch { /* skip if already moved */ }
      }
    } catch (err) {
      console.warn('[scheduler] _flushRetryQueue error:', err.message);
    }
  }

  // ── Job execution ──────────────────────────────────────────────────

  /**
   * Load workflow definition, run it, and handle success/failure.
   */
  async _executeJob(queue, filename, job, user) {
    const userId     = job.user_id;
    const workflowId = job.workflow_id;

    try {
      // Load the workflow definition
      const workflowPath = path.join(DATA_DIR, 'workflows', userId, `${workflowId}.waiflo.json`);
      let workflowDef;
      try {
        const raw = await fs.readFile(workflowPath, 'utf8');
        workflowDef = JSON.parse(raw);
      } catch (err) {
        throw new Error(`Could not load workflow "${workflowId}": ${err.message}`);
      }

      // Resolve user if not already loaded
      const resolvedUser = user || await getUser(userId) || { plan: null };

      // Execute the workflow DAG
      const result = await workflowExecutor.execute(job, workflowDef, resolvedUser);

      if (result.ok) {
        // Write result alongside job file in exec_ok
        await queue.ack_success(filename);
        // Persist result next to the job file
        await this._persistResult(queue, filename, result, 'exec_ok').catch(() => {});
        console.log(`[scheduler] Job ${filename} completed OK.`);
      } else {
        await queue.retry(filename);
        console.warn(`[scheduler] Job ${filename} failed (step: ${result.failedStep}): ${result.error}`);
      }

    } catch (err) {
      console.error(`[scheduler] Job ${filename} execution error:`, err.message);
      await queue.retry(filename).catch(() => {});
    } finally {
      concurrencyManager.release(userId);
    }
  }

  /**
   * Persist execution result as a companion file next to the job file.
   * File: exec_ok/{basename}.result.json
   */
  async _persistResult(queue, filename, result, subdir) {
    const base = filename.replace(/\.json$/, '');
    const resultFile = path.join(queue.dirs[subdir], `${base}.result.json`);
    await fs.writeFile(resultFile, JSON.stringify(result, null, 2), 'utf8');
  }

  // ── Helpers ────────────────────────────────────────────────────────

  async _listDir(dir) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter(e => e.isDirectory()).map(e => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}

/** Singleton scheduler instance. */
export const scheduler = new WorkflowScheduler();
