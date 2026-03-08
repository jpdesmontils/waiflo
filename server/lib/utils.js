import path from 'path';
import { workflowDir } from './users.js';

export function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9_\-\.]/g, '').replace(/\.+/g, '.').slice(0, 120);
}

export function wfPath(userId, name) {
  const dir  = workflowDir(userId);
  const safe = safeName(name);
  if (!safe) throw new Error('Invalid workflow name');
  const filename = safe.endsWith('.waiflo.json') ? safe : `${safe}.waiflo.json`;
  return path.join(dir, filename);
}
