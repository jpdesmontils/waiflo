import fs from 'fs/promises';
import path from 'path';
import { safeName } from './utils.js';

const DATA_DIR = process.env.DATA_DIR || './waiflo-data';

function runBaseDir(userId) {
  return path.join(DATA_DIR, 'runs', safeName(userId || 'guest'));
}

function workflowDir(userId, workflowName) {
  const wf = safeName(workflowName || 'default');
  if (!wf) throw new Error('Invalid workflow name for run store');
  return path.join(runBaseDir(userId), wf);
}

function stepDir(userId, workflowName, stepName) {
  const step = safeName(stepName || 'step');
  if (!step) throw new Error('Invalid step name for run store');
  return path.join(workflowDir(userId, workflowName), step);
}

export async function saveStepRunRecord(userId, workflowName, stepName, payload) {
  const dir = stepDir(userId, workflowName, stepName);
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fp = path.join(dir, `${stamp}.json`);
  await fs.writeFile(fp, JSON.stringify(payload, null, 2), 'utf8');
  return fp;
}

export async function getLatestStepRunRecord(userId, workflowName, stepName) {
  const dir = stepDir(userId, workflowName, stepName);
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.json')).sort();
  if (!files.length) return null;
  const fp = path.join(dir, files[files.length - 1]);
  const raw = await fs.readFile(fp, 'utf8');
  return JSON.parse(raw);
}

export async function deleteWorkflowRunData(userId, workflowName) {
  const dir = workflowDir(userId, workflowName);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function deleteStepRunData(userId, workflowName, stepName) {
  const dir = stepDir(userId, workflowName, stepName);
  await fs.rm(dir, { recursive: true, force: true });
}

export async function pruneWorkflowRunData(userId, workflowName, allowedSteps = []) {
  const wfDir = workflowDir(userId, workflowName);
  const allowed = new Set(allowedSteps.map(s => safeName(s)).filter(Boolean));
  let dirs = [];
  try {
    dirs = await fs.readdir(wfDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  await Promise.all(dirs
    .filter(d => d.isDirectory() && !allowed.has(d.name))
    .map(d => fs.rm(path.join(wfDir, d.name), { recursive: true, force: true })));
}
