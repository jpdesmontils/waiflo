import fs from 'fs/promises';
import path from 'path';
import { getServerConfig } from './configLoader.js';

const DATA_DIR   = process.env.DATA_DIR || './waiflo-data';
const QUEUE_ROOT = path.join(DATA_DIR, 'file_queues');
const HOUR_MS    = 3_600_000;

/**
 * Periodically delete old exec_ok/ files that have exceeded queue_retention_days.
 *
 * - Runs every hour
 * - Reads queue_retention_days from server_config.json
 * - Deletes files older than retention threshold from all exec_ok/ directories
 * - Determines age from file content's created_at field or file mtime as fallback
 * - Silently ignores missing directories (ENOENT)
 */
export function startQueuePurge() {
  console.log('[queuePurge] Queue purge system started (runs every hour).');
  // Run immediately on startup, then every hour
  _runPurge().catch(err => console.error('[queuePurge] Initial purge error:', err));
  return setInterval(() => {
    _runPurge().catch(err => console.error('[queuePurge] Purge error:', err));
  }, HOUR_MS);
}

async function _runPurge() {
  const config = getServerConfig();
  const retentionDays = config.queue_retention_days ?? 7;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  let deleted = 0;

  try {
    const userIds = await _listDirs(QUEUE_ROOT);
    for (const userId of userIds) {
      const userDir = path.join(QUEUE_ROOT, userId);
      const workflowIds = await _listDirs(userDir);
      for (const workflowId of workflowIds) {
        const execOkDir = path.join(userDir, workflowId, 'exec_ok');
        deleted += await _purgeDir(execOkDir, cutoffMs);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[queuePurge] Scan error:', err.message);
    }
  }

  if (deleted > 0) {
    console.log(`[queuePurge] Purged ${deleted} expired file(s) from exec_ok directories.`);
  }
}

/**
 * Delete files in a directory that are older than cutoffMs.
 * @param {string} dir
 * @param {number} cutoffMs - epoch ms threshold
 * @returns {number} count of deleted files
 */
async function _purgeDir(dir, cutoffMs) {
  let count = 0;
  let files;
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return 0;
    throw err;
  }

  for (const filename of files) {
    if (!filename.endsWith('.json')) continue;
    const filepath = path.join(dir, filename);
    try {
      const age = await _getFileAge(filepath);
      if (age < cutoffMs) {
        await fs.unlink(filepath);
        count++;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[queuePurge] Could not process ${filepath}:`, err.message);
      }
    }
  }

  return count;
}

/**
 * Determine the creation time of a job file.
 * Tries to read created_at from file content first; falls back to file mtime.
 * @param {string} filepath
 * @returns {number} epoch ms of file creation
 */
async function _getFileAge(filepath) {
  try {
    const raw = await fs.readFile(filepath, 'utf8');
    const data = JSON.parse(raw);
    if (data?.created_at) {
      const ts = new Date(data.created_at).getTime();
      if (!isNaN(ts)) return ts;
    }
  } catch { /* fall through to mtime */ }

  const stat = await fs.stat(filepath);
  return stat.mtimeMs;
}

async function _listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}
