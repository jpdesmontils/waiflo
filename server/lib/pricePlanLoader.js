import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getServerConfig } from './configLoader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _plans = null;

function loadPlans() {
  if (_plans) return _plans;
  const planPath = path.resolve(__dirname, '../price_plan.json');
  try {
    const raw = fs.readFileSync(planPath, 'utf8');
    _plans = JSON.parse(raw).plans || [];
  } catch (err) {
    console.warn('[pricePlanLoader] Could not read price_plan.json, using defaults:', err.message);
    _plans = [
      { name: 'starter', max_parallel_workflows: 2, price_month: 0 },
      { name: 'pro',     max_parallel_workflows: 5, price_month: 19 },
      { name: 'scale',   max_parallel_workflows: 10, price_month: 49 }
    ];
  }
  return _plans;
}

/**
 * Returns all pricing plans.
 * @returns {Array<{ name: string, max_parallel_workflows: number, price_month: number }>}
 */
export function getPricePlans() {
  return loadPlans();
}

/**
 * Returns a single plan by name, or null if not found.
 * @param {string} name
 * @returns {{ name: string, max_parallel_workflows: number, price_month: number } | null}
 */
export function getPlanByName(name) {
  return loadPlans().find(p => p.name === name) || null;
}

/**
 * Returns the effective maximum parallel workflows for a user.
 * Resolution order:
 * 1. user.selected_parallel_workflows if set and <= plan.max_parallel_workflows
 * 2. plan.max_parallel_workflows if plan exists
 * 3. server config default_parallel_per_user
 *
 * @param {{ plan?: string, selected_parallel_workflows?: number }} user
 * @returns {number}
 */
export function getUserMaxParallel(user) {
  const config = getServerConfig();
  const plan = user?.plan ? getPlanByName(user.plan) : null;

  if (plan) {
    const selected = user?.selected_parallel_workflows;
    if (typeof selected === 'number' && selected >= 1 && selected <= plan.max_parallel_workflows) {
      return selected;
    }
    return plan.max_parallel_workflows;
  }

  return config.default_parallel_per_user;
}
