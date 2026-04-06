function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return fallback;
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DATA_DIR = process.env.DATA_DIR || './waiflo-data';

export const CACHE_CONFIG = {
  enabled: envBool('WF_STEP_CACHE_ENABLED', true),
  scopeByUser: envBool('WF_STEP_CACHE_SCOPE_BY_USER', true),
  ttlDays: envNumber('WF_STEP_CACHE_TTL_DAYS', 7),
  cleanupIntervalMinutes: envNumber('WF_STEP_CACHE_CLEANUP_INTERVAL_MINUTES', 60),
  cachePromptOnly: envBool('WF_STEP_CACHE_PROMPT_ONLY', true),
  dir: `${DATA_DIR}/step-cache`
};
