import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import { CACHE_CONFIG } from '../config.js';
import { safeName } from './utils.js';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function checksumFromObject(payload) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

function userSegment(userId) {
  if (!CACHE_CONFIG.scopeByUser) return 'global';
  return safeName(userId || 'guest') || 'guest';
}

function stepSegments(workflowName, stepName) {
  const workflow = safeName(workflowName || 'default') || 'default';
  const step = safeName(stepName || 'step') || 'step';
  return { workflow, step };
}

export function computeStepCacheKey({ userId, workflowName, stepName, wsType, inputs, keyParams = {} }) {
  return checksumFromObject({
    userId: CACHE_CONFIG.scopeByUser ? (userId || 'guest') : 'global',
    workflowName: workflowName || 'default',
    stepName: stepName || 'step',
    wsType: wsType || 'prompt',
    inputs: inputs || {},
    keyParams: keyParams || {}
  });
}

function cacheFilePath({ userId, workflowName, stepName, key }) {
  const user = userSegment(userId);
  const { workflow, step } = stepSegments(workflowName, stepName);
  return path.join(CACHE_CONFIG.dir, user, workflow, step, `${key}.json`);
}

export async function getCachedStepResult({ userId, workflowName, stepName, wsType, inputs, keyParams = {} }) {
  const key = computeStepCacheKey({ userId, workflowName, stepName, wsType, inputs, keyParams });
  const fp = cacheFilePath({ userId, workflowName, stepName, key });

  let raw;
  try {
    raw = await fs.readFile(fp, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { hit: false, key };
    throw err;
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    await fs.rm(fp, { force: true });
    return { hit: false, key, corrupted: true };
  }

  record.lastReadAt = new Date().toISOString();
  await fs.writeFile(fp, JSON.stringify(record, null, 2), 'utf8');

  return {
    hit: true,
    key,
    output: record.output,
    record
  };
}

export async function saveCachedStepResult({ userId, workflowName, stepName, wsType, inputs, output, meta = {}, keyParams = {} }) {
  const key = computeStepCacheKey({ userId, workflowName, stepName, wsType, inputs, keyParams });
  const fp = cacheFilePath({ userId, workflowName, stepName, key });
  await fs.mkdir(path.dirname(fp), { recursive: true });

  const now = new Date().toISOString();
  const record = {
    key,
    userId: userId || 'guest',
    workflowName: workflowName || 'default',
    stepName: stepName || 'step',
    wsType: wsType || 'prompt',
    inputs: inputs || {},
    status: 'done',
    output,
    createdAt: now,
    lastReadAt: now,
    meta
  };

  await fs.writeFile(fp, JSON.stringify(record, null, 2), 'utf8');
  return { key, path: fp, record };
}

async function collectJsonFiles(dir, files = []) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return files;
    throw err;
  }

  for (const entry of entries) {
    const fp = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonFiles(fp, files);
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fp);
    }
  }
  return files;
}

export async function purgeExpiredStepCacheEntries({ now = Date.now(), ttlDays = CACHE_CONFIG.ttlDays } = {}) {
  const ttlMs = Math.max(0, Number(ttlDays) || 0) * 24 * 60 * 60 * 1000;
  const files = await collectJsonFiles(CACHE_CONFIG.dir, []);
  let removed = 0;

  for (const fp of files) {
    let raw;
    try {
      raw = await fs.readFile(fp, 'utf8');
    } catch {
      continue;
    }

    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      await fs.rm(fp, { force: true });
      removed += 1;
      continue;
    }

    const stamp = Date.parse(record.lastReadAt || record.createdAt || '');
    if (!Number.isFinite(stamp) || now - stamp > ttlMs) {
      await fs.rm(fp, { force: true });
      removed += 1;
    }
  }

  return { scanned: files.length, removed };
}

export async function clearUserStepCache(userId) {
  const dir = path.join(CACHE_CONFIG.dir, userSegment(userId));
  const files = await collectJsonFiles(dir);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { deleted: files.length };
}

let janitorStarted = false;

export function startStepCacheJanitor() {
  if (janitorStarted || !CACHE_CONFIG.enabled) return;
  janitorStarted = true;

  const runPurge = async () => {
    try {
      await purgeExpiredStepCacheEntries();
    } catch (err) {
      console.error('[STEP CACHE PURGE ERROR]', err);
    }
  };

  runPurge();
  const intervalMs = Math.max(1, Number(CACHE_CONFIG.cleanupIntervalMinutes) || 60) * 60 * 1000;
  const timer = setInterval(runPurge, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
}
