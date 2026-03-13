import { stepWorkerPool } from './stepWorkerPool.js';

/**
 * Resolves a value reference against workflow inputs and completed step results.
 *
 * Supported reference patterns:
 *   "$input"             → entire workflow input object
 *   "$input.field"       → workflow input field (dot notation)
 *   "$steps.stepId"      → entire output of a step
 *   "$steps.stepId.field" → specific field from step output (dot notation)
 *
 * Non-string values are returned as-is.
 *
 * @param {any} ref - the reference to resolve
 * @param {object} workflowInputs - job.inputs
 * @param {Map<string, any>} stepResults - results keyed by step_id
 * @returns {any}
 */
function resolveRef(ref, workflowInputs, stepResults) {
  if (typeof ref !== 'string') return ref;

  if (ref === '$input') return workflowInputs;

  if (ref.startsWith('$input.')) {
    return getNestedValue(workflowInputs, ref.slice('$input.'.length));
  }

  if (ref === '$steps') return Object.fromEntries(stepResults);

  if (ref.startsWith('$steps.')) {
    const rest = ref.slice('$steps.'.length);
    const dotIdx = rest.indexOf('.');
    if (dotIdx === -1) {
      return stepResults.get(rest);
    }
    const stepId = rest.slice(0, dotIdx);
    const fieldPath = rest.slice(dotIdx + 1);
    const stepOutput = stepResults.get(stepId);
    if (stepOutput == null) return undefined;
    return getNestedValue(stepOutput, fieldPath);
  }

  return ref;
}

function getNestedValue(obj, dotPath) {
  const parts = dotPath.split('.');
  let val = obj;
  for (const part of parts) {
    if (val == null || typeof val !== 'object') return undefined;
    val = val[part];
  }
  return val;
}

/**
 * Resolves all inputs for a node by substituting references.
 * @param {object} nodeInputs - raw inputs map from node definition
 * @param {object} workflowInputs
 * @param {Map<string, any>} stepResults
 * @returns {object}
 */
function resolveNodeInputs(nodeInputs, workflowInputs, stepResults) {
  if (!nodeInputs || typeof nodeInputs !== 'object') return {};
  const resolved = {};
  for (const [key, val] of Object.entries(nodeInputs)) {
    resolved[key] = resolveRef(val, workflowInputs, stepResults);
  }
  return resolved;
}

/**
 * Evaluate a run_if condition.
 * @param {{ ref: string, exists: boolean }} runIf
 * @param {object} workflowInputs
 * @param {Map<string, any>} stepResults
 * @returns {boolean} true if the node should run
 */
function evaluateRunIf(runIf, workflowInputs, stepResults) {
  if (!runIf || typeof runIf !== 'object') return true;
  const value = resolveRef(runIf.ref, workflowInputs, stepResults);
  const exists = value != null;
  if (runIf.exists === true) return exists;
  if (runIf.exists === false) return !exists;
  return true;
}

/**
 * DAG-based parallel workflow executor.
 *
 * Execution model:
 * 1. Build the dependency graph from wf_nodes[].depends_on
 * 2. Find the initial wave: nodes with no dependencies
 * 3. Execute each wave in parallel using Promise.all()
 * 4. After each wave, find newly unblocked nodes
 * 5. Continue until all nodes are done or a failure halts execution
 */
export class WorkflowExecutor {
  /**
   * Execute a complete workflow.
   *
   * @param {object} job              - queue job { inputs, workflow_id, user_id, ... }
   * @param {object} workflowDef      - parsed .waiflo.json content
   * @param {object} user             - user record (for API key resolution)
   * @returns {Promise<{ ok: boolean, output: any, steps: object, error?: string, failedStep?: string }>}
   */
  async execute(job, workflowDef, user) {
    const nodes = workflowDef.wf_nodes || [];
    const stepDefs = workflowDef.steps || [];
    const workflowInputs = job.inputs || {};

    // Build a map of step definitions by ws_name for quick lookup
    const stepDefMap = new Map(stepDefs.map(s => [s.ws_name, s]));

    // Build adjacency: nodeId → Set of dependency nodeIds
    const deps = new Map();
    for (const node of nodes) {
      deps.set(node.step_id, new Set(Array.isArray(node.depends_on) ? node.depends_on : []));
    }

    // stepResults: Map<step_id, result>
    const stepResults = new Map();
    // skippedNodes: Set of step_ids that were skipped due to run_if
    const skippedNodes = new Set();
    // completedNodes: Set of step_ids finished (success or skip)
    const completedNodes = new Set();

    // Nodes indexed by step_id
    const nodeMap = new Map(nodes.map(n => [n.step_id, n]));

    const allNodeIds = new Set(nodes.map(n => n.step_id));

    /**
     * Check if all dependencies of a node are completed (or skipped).
     */
    const allDepsResolved = (nodeId) => {
      const nodeDeps = deps.get(nodeId) || new Set();
      for (const dep of nodeDeps) {
        if (!completedNodes.has(dep)) return false;
      }
      return true;
    };

    /**
     * Find nodes that are ready to run: not yet started, all deps resolved.
     */
    const getReadyNodes = () => {
      const ready = [];
      for (const nodeId of allNodeIds) {
        if (completedNodes.has(nodeId)) continue;
        if (allDepsResolved(nodeId)) {
          ready.push(nodeId);
        }
      }
      return ready;
    };

    // Execute waves until all nodes are done
    while (completedNodes.size < allNodeIds.size) {
      const readyIds = getReadyNodes();

      if (readyIds.length === 0) {
        // No progress possible — likely a cycle or orphaned nodes
        if (completedNodes.size < allNodeIds.size) {
          const remaining = [...allNodeIds].filter(id => !completedNodes.has(id));
          throw new Error(`Workflow DAG deadlock. Remaining nodes: ${remaining.join(', ')}`);
        }
        break;
      }

      // Execute all ready nodes in parallel
      const waveResults = await Promise.allSettled(
        readyIds.map(nodeId => this._executeNode(nodeId, nodeMap, stepDefMap, workflowInputs, stepResults, skippedNodes, user))
      );

      // Process results
      for (let i = 0; i < readyIds.length; i++) {
        const nodeId = readyIds[i];
        const result = waveResults[i];

        if (result.status === 'fulfilled') {
          const { skipped, output } = result.value;
          if (skipped) {
            skippedNodes.add(nodeId);
          } else {
            stepResults.set(nodeId, output);
          }
          completedNodes.add(nodeId);
        } else {
          // Node failed — propagate error
          return {
            ok: false,
            error: result.reason?.message || String(result.reason),
            failedStep: nodeId,
            steps: Object.fromEntries(stepResults)
          };
        }
      }
    }

    // Resolve final output
    const output = this._resolveWorkflowOutput(workflowDef, workflowInputs, stepResults);

    return {
      ok: true,
      output,
      steps: Object.fromEntries(stepResults)
    };
  }

  /**
   * Execute a single node, returning { skipped, output }.
   */
  async _executeNode(nodeId, nodeMap, stepDefMap, workflowInputs, stepResults, skippedNodes, user) {
    const node = nodeMap.get(nodeId);
    if (!node) throw new Error(`Node "${nodeId}" not found in workflow`);

    // Evaluate run_if condition
    if (node.run_if) {
      const shouldRun = evaluateRunIf(node.run_if, workflowInputs, stepResults);
      if (!shouldRun) {
        return { skipped: true, output: null };
      }
    }

    // Resolve step definition
    const wsRef = node.ws_ref;
    const stepDef = stepDefMap.get(wsRef);
    if (!stepDef) throw new Error(`Step definition "${wsRef}" not found for node "${nodeId}"`);

    // Merge node-level overrides into step definition
    const effectiveStepDef = { ...stepDef };
    if (node.retry) effectiveStepDef.ws_retry = node.retry;
    if (node.timeout_ms) effectiveStepDef.ws_timeout_ms = node.timeout_ms;

    // Resolve inputs
    const resolvedInputs = resolveNodeInputs(node.inputs, workflowInputs, stepResults);

    // Apply timeout if configured
    const timeoutMs = effectiveStepDef.ws_timeout_ms || node.timeout_ms || 0;

    let executionPromise = stepWorkerPool.runStep(effectiveStepDef, resolvedInputs, user);

    if (timeoutMs > 0) {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Step "${nodeId}" timed out after ${timeoutMs}ms`)), timeoutMs)
      );
      executionPromise = Promise.race([executionPromise, timeoutPromise]);
    }

    const output = await executionPromise;
    return { skipped: false, output };
  }

  /**
   * Resolve the workflow's final output value.
   * wf_output can be a reference like "$steps.stepName" or "$steps.stepName.field".
   */
  _resolveWorkflowOutput(workflowDef, workflowInputs, stepResults) {
    const wfOutput = workflowDef.wf_output;
    if (!wfOutput) {
      // Return all step results as output
      return Object.fromEntries(stepResults);
    }
    return resolveRef(wfOutput, workflowInputs, stepResults);
  }
}

/** Singleton executor instance. */
export const workflowExecutor = new WorkflowExecutor();
