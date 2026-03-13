import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';

/**
 * Filesystem-based FIFO queue for workflow job execution.
 *
 * Directory structure:
 *   {baseDir}/{userId}/{workflowId}/
 *     queue/        ← incoming jobs, FIFO by filename timestamp
 *     processing/   ← in-flight jobs
 *     exec_ok/      ← completed successfully
 *     exec_ko/      ← failed permanently
 *     retry_queue/  ← pending retry
 *
 * Job filename format: {unix_ms}_{uuid_short}.json
 *
 * All state transitions use atomic fs.rename operations.
 */
export class cQueue_management {
  /**
   * @param {string} baseDir  - root queue directory (e.g. DATA_DIR/file_queues)
   * @param {string} userId
   * @param {string} workflowId
   */
  constructor(baseDir, userId, workflowId) {
    this.root = path.join(baseDir, userId, workflowId);
    this.dirs = {
      queue:        path.join(this.root, 'queue'),
      processing:   path.join(this.root, 'processing'),
      exec_ok:      path.join(this.root, 'exec_ok'),
      exec_ko:      path.join(this.root, 'exec_ko'),
      retry_queue:  path.join(this.root, 'retry_queue')
    };
  }

  /**
   * Ensure all queue subdirectories exist.
   */
  async ensureDirs() {
    await Promise.all(Object.values(this.dirs).map(d => fs.mkdir(d, { recursive: true })));
  }

  /**
   * Enqueue a new job. Writes a timestamped file to queue/.
   * @param {object} job - job payload (will have workflow_id, user_id, inputs, created_at, retry, max_retry)
   * @returns {string} filename
   */
  async enqueue(job) {
    await this.ensureDirs();
    const filename = `${Date.now()}_${randomUUID().slice(0, 8)}.json`;
    const fullJob = {
      ...job,
      created_at: job.created_at || new Date().toISOString(),
      retry: job.retry ?? 0,
      max_retry: job.max_retry ?? 3
    };
    await fs.writeFile(
      path.join(this.dirs.queue, filename),
      JSON.stringify(fullJob, null, 2),
      'utf8'
    );
    return filename;
  }

  /**
   * Peek at the oldest job in queue/ without moving it.
   * Caller must call moveToProcessing() to claim it.
   * @returns {{ filename: string, job: object } | null}
   */
  async dequeue() {
    await this.ensureDirs();
    const files = await this._listDir(this.dirs.queue);
    if (!files.length) return null;
    const filename = files[0];
    const job = await this._readJob(this.dirs.queue, filename);
    return { filename, job };
  }

  /**
   * List all filenames in queue/ sorted ascending (FIFO order).
   * @returns {string[]}
   */
  async listQueue() {
    await this.ensureDirs();
    return this._listDir(this.dirs.queue);
  }

  /**
   * Atomically move a job from queue/ to processing/.
   * @param {string} filename
   */
  async moveToProcessing(filename) {
    await fs.rename(
      path.join(this.dirs.queue, filename),
      path.join(this.dirs.processing, filename)
    );
  }

  /**
   * Atomically move a job from retry_queue/ to processing/.
   * @param {string} filename
   */
  async moveRetryToProcessing(filename) {
    await fs.rename(
      path.join(this.dirs.retry_queue, filename),
      path.join(this.dirs.processing, filename)
    );
  }

  /**
   * Acknowledge successful completion: processing/ → exec_ok/.
   * @param {string} filename
   */
  async ack_success(filename) {
    await fs.rename(
      path.join(this.dirs.processing, filename),
      path.join(this.dirs.exec_ok, filename)
    );
  }

  /**
   * Acknowledge permanent failure: processing/ → exec_ko/.
   * @param {string} filename
   */
  async ack_failure(filename) {
    await fs.rename(
      path.join(this.dirs.processing, filename),
      path.join(this.dirs.exec_ko, filename)
    );
  }

  /**
   * Handle job retry logic:
   * - If retry < max_retry: increment retry counter, move processing/ → retry_queue/
   * - If retry >= max_retry: move processing/ → exec_ko/
   * @param {string} filename
   */
  async retry(filename) {
    const job = await this._readJob(this.dirs.processing, filename);
    const retryCount = (job.retry ?? 0) + 1;

    if (retryCount <= (job.max_retry ?? 3)) {
      const updatedJob = { ...job, retry: retryCount };
      await fs.writeFile(
        path.join(this.dirs.processing, filename),
        JSON.stringify(updatedJob, null, 2),
        'utf8'
      );
      await fs.rename(
        path.join(this.dirs.processing, filename),
        path.join(this.dirs.retry_queue, filename)
      );
    } else {
      await fs.rename(
        path.join(this.dirs.processing, filename),
        path.join(this.dirs.exec_ko, filename)
      );
    }
  }

  /**
   * List all jobs currently in processing/.
   * @returns {Array<{ filename: string, job: object }>}
   */
  async getProcessingJobs() {
    await this.ensureDirs();
    const files = await this._listDir(this.dirs.processing);
    return Promise.all(files.map(async filename => ({
      filename,
      job: await this._readJob(this.dirs.processing, filename)
    })));
  }

  /**
   * List all jobs in retry_queue/.
   * @returns {Array<{ filename: string, job: object }>}
   */
  async listRetryQueue() {
    await this.ensureDirs();
    const files = await this._listDir(this.dirs.retry_queue);
    return Promise.all(files.map(async filename => ({
      filename,
      job: await this._readJob(this.dirs.retry_queue, filename)
    })));
  }

  /**
   * Find which subdirectory a job file currently lives in.
   * @param {string} filename
   * @returns {'queue'|'processing'|'exec_ok'|'exec_ko'|'retry_queue'|null}
   */
  async getJobStatus(filename) {
    for (const [name, dir] of Object.entries(this.dirs)) {
      try {
        await fs.access(path.join(dir, filename));
        return name;
      } catch { /* not here */ }
    }
    return null;
  }

  // ── Internal helpers ───────────────────────────────────────────────

  async _listDir(dir) {
    try {
      const entries = await fs.readdir(dir);
      return entries.filter(f => f.endsWith('.json')).sort();
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async _readJob(dir, filename) {
    const raw = await fs.readFile(path.join(dir, filename), 'utf8');
    return JSON.parse(raw);
  }
}
