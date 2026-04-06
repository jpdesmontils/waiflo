/**
 * @typedef {Object} WorkflowLogFile
 * @property {string} id
 * @property {string} workflowName
 * @property {string} nodeId
 * @property {string} stepName
 * @property {string} wsType
 * @property {'manual'|'scheduled'|'api'|'retry'} runMode
 * @property {Record<string, any>} inputs
 * @property {'success'|'error'|'running'|'queued'} status
 * @property {string|Object} logOutput
 * @property {any} output
 * @property {string} prompt
 * @property {Record<string, any>} logMeta
 * @property {string} createdAt
 */

/**
 * @typedef {Object} WorkflowStepView
 * @property {string} id
 * @property {number} order
 * @property {string} nodeId
 * @property {string} stepName
 * @property {string} wsType
 * @property {'success'|'error'|'running'|'queued'} status
 * @property {string} createdAt
 * @property {WorkflowLogFile} raw
 */

/**
 * @typedef {Object} WorkflowRunView
 * @property {string} id
 * @property {string} workflowName
 * @property {'manual'|'scheduled'|'api'|'retry'} runMode
 * @property {'success'|'error'|'running'|'queued'} status
 * @property {string} createdAt
 * @property {number|null} durationMs
 * @property {number} stepsCount
 * @property {string} lastStep
 * @property {WorkflowStepView[]} steps
 */

/**
 * @typedef {Object} WorkflowView
 * @property {string} workflowName
 * @property {WorkflowRunView[]} runs
 */
