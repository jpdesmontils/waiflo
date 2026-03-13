import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _config = null;

/**
 * Load and cache the server configuration from server_config.json.
 * @returns {{ max_parallel_workflows_global: number, max_parallel_steps: number, default_parallel_per_user: number, queue_retention_days: number }}
 */
export function getServerConfig() {
  if (_config) return _config;
  const configPath = path.resolve(__dirname, '../server_config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    _config = JSON.parse(raw);
  } catch (err) {
    console.warn('[configLoader] Could not read server_config.json, using defaults:', err.message);
    _config = {
      max_parallel_workflows_global: 100,
      max_parallel_steps: 200,
      default_parallel_per_user: 2,
      queue_retention_days: 7
    };
  }
  return _config;
}
