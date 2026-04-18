/** @typedef {import('./model.js').WorkflowLogFile} WorkflowLogFile */

/**
 * Rebuild Workflow > Run > Steps hierarchy from flat logs.
 * @param {WorkflowLogFile[]} files
 * @returns {import('./model.js').WorkflowView[]}
 */
export function mapLogsToWorkflowViews(files) {
  const byWorkflow = new Map();
  for (const file of files) {
    if (!byWorkflow.has(file.workflowName)) byWorkflow.set(file.workflowName, []);
    byWorkflow.get(file.workflowName).push(file);
  }

  return [...byWorkflow.entries()].map(([workflowName, rows]) => {
    const runsById = new Map();

    for (const row of rows) {
      const runId = row.runId || row.logMeta?.runId || `${workflowName}-${row.runMode}-${row.createdAt.slice(0, 16)}`;
      if (!runsById.has(runId)) runsById.set(runId, []);
      runsById.get(runId).push(row);
    }

    const runs = [...runsById.entries()].map(([runId, runRows]) => {
      const orderedRows = runRows
        .slice()
        .sort((a, b) => (a.logMeta?.stepOrder ?? 9999) - (b.logMeta?.stepOrder ?? 9999));

      const stepStatuses = orderedRows.map((row) => normalizeStatus(row.status));
      const status = stepStatuses.includes('error')
        ? 'error'
        : stepStatuses.includes('running')
          ? 'running'
          : stepStatuses.includes('queued') ? 'queued' : 'success';

      const startedAt = orderedRows[0]?.logMeta?.runStartedAt || orderedRows[0]?.createdAt;
      const finishedAt = orderedRows[orderedRows.length - 1]?.logMeta?.runFinishedAt
        || orderedRows[orderedRows.length - 1]?.createdAt;
      const durationMs = finishedAt ? (new Date(finishedAt).getTime() - new Date(startedAt).getTime()) : null;

      const steps = orderedRows.map((row, index) => ({
        id: row.id || `${runId}-${row.nodeId || row.stepName || 'step'}-${index}`,
        order: row.logMeta?.stepOrder ?? index + 1,
        nodeId: row.nodeId,
        stepName: row.stepName,
        wsType: row.wsType,
        status: normalizeStatus(row.status),
        createdAt: row.createdAt,
        raw: row
      }));

      return {
        id: runId,
        workflowName,
        runMode: orderedRows[0]?.runMode || 'manual',
        callerIp: orderedRows[0]?.callerIp || '',
        status,
        createdAt: startedAt,
        durationMs,
        stepsCount: steps.length,
        lastStep: steps[steps.length - 1]?.stepName || '—',
        steps
      };
    }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return { workflowName, runs };
  });
}

function normalizeStatus(rawStatus) {
  const status = String(rawStatus || '').toLowerCase();
  if (status === 'done' || status === 'done_raw' || status === 'success') return 'success';
  if (status === 'running') return 'running';
  if (status === 'queued') return 'queued';
  return 'error';
}

export function buildKpis(filteredRuns) {
  const executions = filteredRuns.length;
  const success = filteredRuns.filter((run) => run.status === 'success').length;
  const successRate = executions ? Math.round((success / executions) * 100) : 0;
  const durations = filteredRuns.map((run) => run.durationMs).filter((duration) => typeof duration === 'number');
  const avgDuration = durations.length ? Math.round(durations.reduce((acc, cur) => acc + cur, 0) / durations.length) : 0;

  const lastErrorRun = filteredRuns
    .filter((run) => run.status === 'error')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  const lastError = lastErrorRun
    ? `${new Date(lastErrorRun.createdAt).toLocaleString()} • ${lastErrorRun.lastStep}`
    : '—';

  return { executions, successRate, avgDuration, lastError };
}
