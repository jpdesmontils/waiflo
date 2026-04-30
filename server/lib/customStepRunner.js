import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import cGenericStep from './steps/cGenericStep.js';

const EXAMPLE_CUSTOM_STEPS_DIR = path.resolve(process.cwd(), 'server/lib/steps/custom');
const USER_CUSTOM_STEPS_DIR = path.resolve(process.cwd(), 'waiflo-data/steps/custom');

function resolveCustomStepConfig(step = {}) {
  const config = step?.ws_custom;
  if (typeof config === 'string') {
    return { module: config, className: null };
  }
  return {
    module: config?.module || config?.path || config?.file || null,
    className: config?.className || config?.class || null
  };
}

async function resolveModulePath(moduleName, runtimeContext = {}) {
  if (!moduleName) throw new Error('Missing ws_custom.module for custom step');
  const normalized = moduleName.endsWith('.js') ? moduleName : `${moduleName}.js`;
  const userId = runtimeContext?.user?.userId || runtimeContext?.userId || null;
  const searchDirs = [];
  if (userId) searchDirs.push(path.resolve(USER_CUSTOM_STEPS_DIR, userId));
  searchDirs.push(EXAMPLE_CUSTOM_STEPS_DIR);

  for (const baseDir of searchDirs) {
    const absPath = path.resolve(baseDir, normalized);
    const rel = path.relative(baseDir, absPath);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    try {
      await fs.access(absPath);
      return absPath;
    } catch {
      // continue search
    }
  }
  throw new Error(`Custom step module "${normalized}" not found`);
}

function resolveExportedClass(moduleExports, className) {
  if (className) {
    const named = moduleExports?.[className];
    if (!named) throw new Error(`Class "${className}" not exported by custom module`);
    return named;
  }
  return moduleExports?.default || moduleExports?.cExampleCustomStep;
}

export async function runCustomStep(step = {}, inputs = {}, runtimeContext = {}) {
  const { module: moduleName, className } = resolveCustomStepConfig(step);
  const absModulePath = await resolveModulePath(moduleName, runtimeContext);
  const moduleUrl = pathToFileURL(absModulePath).href;
  const loaded = await import(moduleUrl);

  const StepClass = resolveExportedClass(loaded, className);
  if (typeof StepClass !== 'function') {
    throw new Error('Custom step export must be a class constructor');
  }

  const instance = new StepClass(step, runtimeContext);
  if (!(instance instanceof cGenericStep)) {
    throw new Error('Custom step class must extend cGenericStep');
  }

  try {
    return await instance.execute(inputs);
  } catch (error) {
    return instance.buildErrorResult(error);
  }
}

export default runCustomStep;
