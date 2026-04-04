import fs from 'fs/promises';
import path from 'path';
import { ensureUserDir } from './users.js';

const POSITIONS_FILENAME = 'graph_positions.json';

function sanitizePoint(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

async function positionsPath(userId) {
  const dir = await ensureUserDir(userId);
  return path.join(dir, POSITIONS_FILENAME);
}

export async function readUserGraphPositions(userId) {
  const fp = await positionsPath(userId);
  try {
    const raw = await fs.readFile(fp, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

export async function writeUserGraphPositions(userId, data) {
  const fp = await positionsPath(userId);
  const safeData = data && typeof data === 'object' ? data : {};
  await fs.writeFile(fp, JSON.stringify(safeData, null, 2), 'utf8');
}

export function extractWorkflowPositions(data) {
  const out = {};
  const workflows = Array.isArray(data?.workflows) ? data.workflows : [];
  for (const wf of workflows) {
    const nodes = Array.isArray(wf?.wf_nodes) ? wf.wf_nodes : [];
    for (const node of nodes) {
      if (!node?.step_id) continue;
      const point = sanitizePoint(node.position);
      if (!point) continue;
      out[node.step_id] = point;
    }
  }
  return out;
}

export function applyWorkflowPositions(data, workflowPositions) {
  if (!data || typeof data !== 'object') return data;
  if (!workflowPositions || typeof workflowPositions !== 'object') return data;
  const workflows = Array.isArray(data.workflows) ? data.workflows : [];
  for (const wf of workflows) {
    const nodes = Array.isArray(wf?.wf_nodes) ? wf.wf_nodes : [];
    for (const node of nodes) {
      if (!node?.step_id) continue;
      const point = sanitizePoint(workflowPositions[node.step_id]);
      if (!point) continue;
      node.position = point;
    }
  }
  return data;
}
